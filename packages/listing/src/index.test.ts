import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks. index.ts pulls getDb/getLogger from @presswork/shared and the agent
// step functions from ./poller.js and ./publisher.js. We mock all three so the
// test exercises run()'s queue orchestration (Phase 1/2/3) against a small
// stateful in-memory listings table — the H1 fix lives in fetchPendingListing,
// which run() drives.
// ---------------------------------------------------------------------------

const mockResumePublish = vi.fn(async (..._args: unknown[]) => undefined);
const mockPublishOne = vi.fn(async (..._args: unknown[]) => undefined);
const mockClaimNextDesignPackage = vi.fn(async () => null as unknown);

vi.mock("./publisher.js", () => ({
  publishOne: mockPublishOne,
  resumePublish: mockResumePublish,
}));

vi.mock("./poller.js", () => ({
  claimNextDesignPackage: mockClaimNextDesignPackage,
}));

interface ListingRow {
  id: string;
  status: string;
  design_package_id: string | null;
  created_at: string;
  error_message?: string | null;
}

/**
 * Minimal stateful Supabase mock tailored to index.ts's query shapes:
 *   - listings select(id|id, design_package_id) .eq("status", s) .order .limit .maybeSingle
 *   - listings update(data) .eq("id", id) .eq("status", s) .select("id")  (error-park write)
 *   - design_packages / trend_briefs select("*") .eq("id", id) .single
 * Mutations are applied to the in-memory `listings` array so a row parked at
 * 'error' no longer surfaces as a 'pending' head on the next query. The
 * error-park UPDATE chains .select("id"), so the awaited result returns the
 * affected rows ({ data: [...] }) — matching supabase-js, which returns the
 * rows the WHERE clause matched (an empty array on a zero-row concurrent race).
 */
function makeDb(initial: {
  listings: ListingRow[];
  designs: Record<string, Record<string, unknown>>;
  briefs: Record<string, Record<string, unknown>>;
  // Test hook: fires immediately after a listings status-SELECT resolves,
  // receiving the snapshot it returned. Lets a test deterministically inject a
  // concurrent race — e.g. flip the just-read row out of 'pending' before the
  // park UPDATE runs, so the UPDATE's status guard matches zero rows.
  onListingsSelect?: (snapshot: ListingRow | null) => void;
}) {
  const listings = initial.listings.map((r) => ({ ...r }));

  function builder(table: string) {
    const filters: Array<[string, unknown]> = [];
    let mode: "select" | "update" = "select";
    let updateData: Record<string, unknown> | null = null;

    const oldestByStatus = (status: string): ListingRow | null => {
      const matches = listings
        .filter((r) => r.status === status)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      return matches[0] ?? null;
    };

    const api: Record<string, unknown> = {
      select: vi.fn(() => api),
      update: vi.fn((data: Record<string, unknown>) => {
        mode = "update";
        updateData = data;
        return api;
      }),
      eq: vi.fn((col: string, val: unknown) => {
        filters.push([col, val]);
        return api;
      }),
      order: vi.fn(() => api),
      limit: vi.fn(() => api),
      maybeSingle: vi.fn(async () => {
        if (table === "listings") {
          const statusFilter = filters.find(([c]) => c === "status")?.[1] as
            | string
            | undefined;
          const row = statusFilter ? oldestByStatus(statusFilter) : null;
          const snapshot = row ? { ...row } : null;
          // Surface only the 'pending' head to the race hook — that's the read
          // fetchPendingListing acts on between SELECT and park UPDATE.
          if (statusFilter === "pending") initial.onListingsSelect?.(snapshot);
          return { data: snapshot, error: null };
        }
        return { data: null, error: null };
      }),
      single: vi.fn(async () => {
        const id = filters.find(([c]) => c === "id")?.[1] as string | undefined;
        if (table === "design_packages") {
          return { data: id ? initial.designs[id] ?? null : null, error: null };
        }
        if (table === "trend_briefs") {
          return { data: id ? initial.briefs[id] ?? null : null, error: null };
        }
        return { data: null, error: null };
      }),
      // Thenable so an awaited update chain resolves to { data, error }. The
      // park UPDATE chains .select("id"), so we mirror supabase-js: `data` is
      // the array of rows the WHERE clause actually matched. A concurrent race
      // (status guard no longer matches) yields an empty array, not a false
      // single-row result.
      then: (
        onFulfilled?: (v: unknown) => unknown,
        onRejected?: (v: unknown) => unknown,
      ) => {
        let data: unknown = null;
        if (mode === "update" && table === "listings" && updateData) {
          const id = filters.find(([c]) => c === "id")?.[1] as
            | string
            | undefined;
          const statusGuard = filters.find(
            ([c]) => c === "status",
          )?.[1] as string | undefined;
          const target = listings.find(
            (r) =>
              r.id === id &&
              (statusGuard === undefined || r.status === statusGuard),
          );
          if (target) {
            Object.assign(target, updateData);
            data = [{ id: target.id }];
          } else {
            data = []; // zero-row update: WHERE matched nothing
          }
        }
        return Promise.resolve({ data, error: null }).then(
          onFulfilled,
          onRejected,
        );
      },
    };
    return api;
  }

  return {
    db: { from: vi.fn((table: string) => builder(table)) },
    listings,
  };
}

const log = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

let dbHandle: ReturnType<typeof makeDb>;

vi.mock("@presswork/shared", () => ({
  getDb: () => dbHandle.db,
  getLogger: () => log,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockResumePublish.mockResolvedValue(undefined);
  mockPublishOne.mockResolvedValue(undefined);
  mockClaimNextDesignPackage.mockResolvedValue(null);
});

describe("run() — H1 null-FK pending row starvation", () => {
  it("error-parks a null-FK pending row and still publishes the next claimable one", async () => {
    const designId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    dbHandle = makeDb({
      listings: [
        // Oldest pending row has a null FK — the H1 starvation trigger.
        {
          id: "11111111-1111-1111-1111-111111111111",
          status: "pending",
          design_package_id: null,
          created_at: "2026-01-01T00:00:00Z",
        },
        // Next-oldest pending row is claimable.
        {
          id: "22222222-2222-2222-2222-222222222222",
          status: "pending",
          design_package_id: designId,
          created_at: "2026-01-02T00:00:00Z",
        },
      ],
      designs: {
        [designId]: { id: designId, trend_brief_id: "bbbb", status: "done" },
      },
      briefs: { bbbb: { id: "bbbb", niche: "cats" } },
    });

    // publishOne owns the row's DB writes; emulate it moving the row out of
    // 'pending' so run()'s drain loop terminates instead of re-claiming it.
    mockPublishOne.mockImplementation(async (...args: unknown[]) => {
      const listingId = args[3] as string;
      const row = dbHandle.listings.find((r) => r.id === listingId);
      if (row) row.status = "active";
      return undefined;
    });

    const { run } = await import("./index");
    await run();

    // The bad row was parked at 'error' with an explanatory message.
    const parked = dbHandle.listings.find(
      (r) => r.id === "11111111-1111-1111-1111-111111111111",
    );
    expect(parked?.status).toBe("error");
    expect(String(parked?.error_message)).toMatch(/no linked design_package_id/i);

    // The claimable row was published, not starved.
    expect(mockPublishOne).toHaveBeenCalledTimes(1);
    const publishedListingId = mockPublishOne.mock.calls[0]?.[3];
    expect(publishedListingId).toBe("22222222-2222-2222-2222-222222222222");
  });

  it("does not false-park (no error log) when a concurrent agent moved the null-FK row out of pending before the UPDATE", async () => {
    const nullFkId = "11111111-1111-1111-1111-111111111111";
    let raceInjected = false;

    dbHandle = makeDb({
      listings: [
        {
          id: nullFkId,
          status: "pending",
          design_package_id: null,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      designs: {},
      briefs: {},
      // Simulate the race exactly once: after fetchPendingListing's SELECT
      // reads the stale 'pending' snapshot, a concurrent agent flips the stored
      // row to 'publishing'. The park UPDATE's .eq("status","pending") guard now
      // matches zero rows.
      onListingsSelect: (snapshot) => {
        if (raceInjected) return;
        if (snapshot?.id === nullFkId && snapshot.status === "pending") {
          raceInjected = true;
          const stored = dbHandle.listings.find((r) => r.id === nullFkId);
          if (stored) stored.status = "publishing";
        }
      },
    });

    const { run } = await import("./index");
    await run();

    // The row was NOT parked at 'error' by us — the concurrent agent owns it.
    const row = dbHandle.listings.find((r) => r.id === nullFkId);
    expect(row?.status).toBe("publishing");
    expect(row?.error_message).toBeUndefined();

    // No false-positive park error log fired; the no-op was logged at warn.
    const parkErrorCalls = log.error.mock.calls.filter(
      (c) => (c[0] as { action?: string })?.action === "pending_null_fk_parked",
    );
    expect(parkErrorCalls).toHaveLength(0);
    const noopWarnCalls = log.warn.mock.calls.filter(
      (c) =>
        (c[0] as { action?: string })?.action === "pending_null_fk_park_noop",
    );
    expect(noopWarnCalls).toHaveLength(1);

    // The loop continued and drained cleanly — no publish, idle exit via Phase 3.
    expect(mockPublishOne).not.toHaveBeenCalled();
    expect(mockClaimNextDesignPackage).toHaveBeenCalled();
  });

  it("returns to idle (no publishOne) when the only pending row has a null FK", async () => {
    dbHandle = makeDb({
      listings: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          status: "pending",
          design_package_id: null,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      designs: {},
      briefs: {},
    });

    const { run } = await import("./index");
    await run();

    const parked = dbHandle.listings[0];
    expect(parked?.status).toBe("error");
    expect(mockPublishOne).not.toHaveBeenCalled();
    // Phase 3 still runs and finds nothing to claim → idle exit.
    expect(mockClaimNextDesignPackage).toHaveBeenCalled();
  });
});

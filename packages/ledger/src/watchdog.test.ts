import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Minimal env that satisfies @presswork/shared's config validation.
// ---------------------------------------------------------------------------

const validEnv = {
  ANTHROPIC_API_KEY: "sk-ant-test",
  ETSY_API_KEY: "etsy-key",
  ETSY_API_SECRET: "etsy-secret",
  ETSY_SHOP_ID: "99",
  ETSY_ACCESS_TOKEN: "access-token",
  ETSY_REFRESH_TOKEN: "refresh-token",
  ETSY_SHIPPING_PROFILE_ID: "99",
  ETSY_PRODUCTION_PARTNER_ID: "999001",
  ETSY_READINESS_STATE_ID: "1",
  FAL_KEY: "fal-key",
  PRINTIFY_API_TOKEN: "printify-token",
  PRINTIFY_SHOP_ID: "shop-1",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  RESEND_API_KEY: "resend-key",
  ALERT_EMAIL: "alert@example.com",
  SLACK_WEBHOOK_URL: "https://hooks.slack.com/test",
  NODE_ENV: "test",
  LOG_LEVEL: "info",
};

// ---------------------------------------------------------------------------
// Mock DB factory
//
// Each table can return a configurable array of rows and an optional error.
// The mock implements the fluent Supabase query chain:
//   db.from(table).select(cols).in(field, values)
// ---------------------------------------------------------------------------

interface TableConfig {
  rows?: Array<{ id: string; status: string; updated_at: string }>;
  error?: { message: string } | null;
}

type DbTableMap = Record<string, TableConfig>;

function makeDbMock(tables: DbTableMap = {}) {
  const fromMock = vi.fn((table: string) => {
    const cfg: TableConfig = tables[table] ?? { rows: [] };
    const error = cfg.error ?? null;
    const rows = cfg.rows ?? [];

    return {
      select: vi.fn().mockReturnValue({
        in: vi.fn().mockResolvedValue({ data: error ? null : rows, error }),
      }),
    };
  });

  return { from: fromMock };
}

// ---------------------------------------------------------------------------
// Fixed reference instants
// ---------------------------------------------------------------------------

const NOW = new Date("2024-06-01T12:00:00.000Z");

/** Returns an ISO string that is `hours` hours before NOW. */
function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}

/** Returns an ISO string that is `minutes` minutes before NOW. */
function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runWatchdog", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, validEnv);
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  // -------------------------------------------------------------------------
  // (a) A stuck "processing" row past the orphan threshold (60 min default)
  //     must be flagged at severity "warn".
  // -------------------------------------------------------------------------

  it("flags a processing row older than WATCHDOG_ORPHAN_MINUTES as warn", async () => {
    const slack = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      notifySlack: slack,
    }));

    const { runWatchdog } = await import("./watchdog.js");

    const db = makeDbMock({
      trend_briefs: {
        rows: [
          // Stuck: 90 minutes old, orphan threshold is 60 min.
          { id: "tb-1", status: "processing", updated_at: minutesAgo(90) },
        ],
      },
      design_packages: { rows: [] },
      listings: { rows: [] },
    });

    const summary = await runWatchdog(db as never, { now: NOW });

    expect(summary.totalStuck).toBe(1);
    expect(summary.findings).toHaveLength(1);
    expect(summary.findings[0]).toMatchObject({
      table: "trend_briefs",
      status: "processing",
      count: 1,
    });

    // Slack must have been called with severity "warn".
    expect(slack).toHaveBeenCalledTimes(1);
    expect(slack).toHaveBeenCalledWith(
      expect.stringContaining("trend_briefs"),
      { severity: "warn" }
    );
    expect(slack).toHaveBeenCalledWith(
      expect.stringContaining("processing"),
      { severity: "warn" }
    );
  });

  // -------------------------------------------------------------------------
  // (b) A "processing" row that is RECENT (30 min) must NOT be flagged.
  //     The orphan threshold is 60 min, so 30 min is still within the window.
  // -------------------------------------------------------------------------

  it("does NOT flag a processing row younger than WATCHDOG_ORPHAN_MINUTES", async () => {
    const slack = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      notifySlack: slack,
    }));

    const { runWatchdog } = await import("./watchdog.js");

    const db = makeDbMock({
      trend_briefs: {
        rows: [
          // Not yet stuck: only 30 minutes old, threshold is 60 min.
          { id: "tb-2", status: "processing", updated_at: minutesAgo(30) },
        ],
      },
      design_packages: { rows: [] },
      listings: { rows: [] },
    });

    const summary = await runWatchdog(db as never, { now: NOW });

    expect(summary.totalStuck).toBe(0);
    expect(summary.findings).toHaveLength(0);
    expect(slack).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (c) A "pending_publish" row past the stale threshold (48 h default) must
  //     be flagged. "pending_publish" is in the STALE tier (not ORPHAN).
  // -------------------------------------------------------------------------

  it("flags a pending_publish listing older than WATCHDOG_STALE_HOURS as warn", async () => {
    const slack = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      notifySlack: slack,
    }));

    const { runWatchdog } = await import("./watchdog.js");

    const db = makeDbMock({
      trend_briefs: { rows: [] },
      design_packages: { rows: [] },
      listings: {
        rows: [
          // Stuck: 73 hours old, stale threshold is 48 h.
          { id: "lst-1", status: "pending_publish", updated_at: hoursAgo(73) },
        ],
      },
    });

    const summary = await runWatchdog(db as never, { now: NOW });

    expect(summary.totalStuck).toBe(1);
    expect(summary.findings[0]).toMatchObject({
      table: "listings",
      status: "pending_publish",
      count: 1,
    });
    // oldest age should be approximately 73 hours.
    expect(summary.findings[0]!.oldestAgeHours).toBeCloseTo(73, 0);

    expect(slack).toHaveBeenCalledTimes(1);
    expect(slack).toHaveBeenCalledWith(
      expect.stringContaining("pending_publish"),
      { severity: "warn" }
    );
  });

  // -------------------------------------------------------------------------
  // (d) Zero stuck rows => no Slack post + log line says "healthy".
  // -------------------------------------------------------------------------

  it("does NOT call notifySlack when zero rows are stuck", async () => {
    const slack = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      notifySlack: slack,
    }));

    const { runWatchdog } = await import("./watchdog.js");

    const db = makeDbMock({
      trend_briefs: { rows: [] },
      design_packages: { rows: [] },
      listings: { rows: [] },
    });

    const summary = await runWatchdog(db as never, { now: NOW });

    expect(summary.totalStuck).toBe(0);
    expect(summary.findings).toHaveLength(0);
    expect(slack).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Bonus: a query error on one table does NOT abort the whole sweep —
  // the other tables are still checked and findings from them are reported.
  // -------------------------------------------------------------------------

  it("continues checking remaining tables when one query fails", async () => {
    const slack = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      notifySlack: slack,
    }));

    const { runWatchdog } = await import("./watchdog.js");

    const db = makeDbMock({
      // trend_briefs query will error.
      trend_briefs: { error: { message: "connection refused" } },
      design_packages: { rows: [] },
      listings: {
        rows: [
          // Stuck listing — should still be caught despite trend_briefs error.
          { id: "lst-2", status: "needs_review", updated_at: hoursAgo(72) },
        ],
      },
    });

    const summary = await runWatchdog(db as never, { now: NOW });

    // listings row must be reported; trend_briefs error must not abort the run.
    expect(summary.totalStuck).toBe(1);
    expect(summary.findings[0]).toMatchObject({
      table: "listings",
      status: "needs_review",
    });
    expect(slack).toHaveBeenCalledTimes(1);
  });
});

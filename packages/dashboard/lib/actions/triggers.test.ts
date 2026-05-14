import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeSupabaseMock, makeFormData, type SupabaseMockOpts } from "@/tests/helpers/supabase-mock";

vi.mock("@/lib/auth", () => ({
  requireOwnerEmail: vi.fn(async () => "owner@test.com"),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Mock child_process.spawn — we never want to actually fork a process in tests.
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    unref: vi.fn(),
  })),
}));

async function loadModule(opts: SupabaseMockOpts) {
  const { client, capture } = makeSupabaseMock(opts);
  vi.doMock("@/lib/supabase/server", () => ({ serviceClient: () => client }));
  vi.resetModules();
  const mod = await import("./triggers");
  return { mod, capture };
}

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  vi.clearAllMocks();
});

afterEach(() => {
  process.env = savedEnv;
});

describe("triggerAgent", () => {
  it("inserts an agent_runs row and revalidates when local triggers are enabled", async () => {
    process.env.DASHBOARD_LOCAL_TRIGGERS_ENABLED = "true";
    const { mod, capture } = await loadModule({
      agent_runs: { single: { id: "run-1" } },
    });

    await mod.triggerAgent(makeFormData({ agent: "design" }));

    expect(capture.inserts).toHaveLength(1);
    expect(capture.inserts[0].table).toBe("agent_runs");
    expect(capture.inserts[0].data).toMatchObject({
      agent: "design",
      triggered_by: "owner@test.com",
    });
  });

  it("throws a friendly error when local triggers are disabled", async () => {
    delete process.env.DASHBOARD_LOCAL_TRIGGERS_ENABLED;
    const { mod } = await loadModule({});

    await expect(mod.triggerAgent(makeFormData({ agent: "design" }))).rejects.toThrow(
      /Local agent triggers are disabled/,
    );
  });
});

describe("getPendingWorkCount", () => {
  it("returns count of trend_briefs at status='approved' for the design agent", async () => {
    const { mod } = await loadModule({ trend_briefs: { count: 4 } });

    const n = await mod.getPendingWorkCount("design");

    expect(n).toBe(4);
  });

  it("returns count of design_packages at status='approved' for the listing agent", async () => {
    const { mod } = await loadModule({ design_packages: { count: 2 } });

    const n = await mod.getPendingWorkCount("listing");

    expect(n).toBe(2);
  });

  it("returns 0 for scout (no upstream queue)", async () => {
    const { mod } = await loadModule({});

    expect(await mod.getPendingWorkCount("scout")).toBe(0);
    expect(await mod.getPendingWorkCount("ledger")).toBe(0);
  });
});

describe("getLastAgentRun", () => {
  it("returns the most recent agent_runs row for the given agent", async () => {
    const row = {
      id: "run-1",
      agent: "design",
      started_at: "2026-05-14T10:00:00Z",
      finished_at: "2026-05-14T10:01:00Z",
      exit_code: 0,
      stdout_tail: "ok",
      stderr_tail: null,
    };
    const { mod } = await loadModule({ agent_runs: { maybeSingle: row } });

    const result = await mod.getLastAgentRun("design");

    expect(result).toEqual(row);
  });

  it("returns null when no rows exist", async () => {
    const { mod } = await loadModule({ agent_runs: { maybeSingle: null } });

    expect(await mod.getLastAgentRun("design")).toBeNull();
  });
});

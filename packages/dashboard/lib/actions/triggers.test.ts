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

describe("spawnAgentForOperatorAction (M5 auth gate)", () => {
  it("throws Unauthorized when the caller is not the owner", async () => {
    process.env.DASHBOARD_LOCAL_TRIGGERS_ENABLED = "true";
    const { mod } = await loadModule({});
    const { requireOwnerEmail } = await import("@/lib/auth");
    vi.mocked(requireOwnerEmail).mockResolvedValueOnce(null);

    await expect(
      mod.spawnAgentForOperatorAction("design", "owner@test.com"),
    ).rejects.toThrow(/Unauthorized/);
  });

  it("spawns and records an agent_runs row when authed and local triggers enabled", async () => {
    process.env.DASHBOARD_LOCAL_TRIGGERS_ENABLED = "true";
    const { mod, capture } = await loadModule({
      agent_runs: { single: { id: "run-9" } },
    });

    const runId = await mod.spawnAgentForOperatorAction("design", "owner@test.com");

    expect(runId).toBe("run-9");
    expect(capture.inserts[0].table).toBe("agent_runs");
    expect(capture.inserts[0].data).toMatchObject({
      agent: "design",
      triggered_by: "owner@test.com",
    });
  });
});

describe("getPendingWorkCount", () => {
  it("returns count of trend_briefs at status='approved' for the design agent", async () => {
    const { mod } = await loadModule({ trend_briefs: { count: 4 } });

    const n = await mod.getPendingWorkCount("design");

    expect(n).toBe(4);
  });

  it("listing count = approved-without-listing + listings at pending + pending_publish", async () => {
    // Two approved designs, one already linked from a listings row.
    // The supabase mock returns the same `count` for every count-mode query
    // on a table, so both pendingListings AND pendingPublishListings get
    // count=1. Expected: 1 unclaimed + 1 pending + 1 pending_publish = 3.
    // Migration 046 added the pending_publish bucket so the Run Listing
    // glow correctly accounts for approved listings waiting to publish.
    const { mod } = await loadModule({
      design_packages: {
        rows: [{ id: "design-A" }, { id: "design-B" }],
      },
      listings: {
        rows: [{ design_package_id: "design-A" }],
        count: 1, // applied to both pending and pending_publish count queries
      },
    });

    const n = await mod.getPendingWorkCount("listing");

    expect(n).toBe(3);
  });

  it("listing count = 0 when every approved design already has a listings row and no pending listings", async () => {
    // Mirrors the user-reported "Run Listing says 15 but there's nothing to do"
    // bug: under the old query this returned 15 because designs stay at
    // 'approved' for life now. New query returns 0 since all of them are
    // already linked.
    const { mod } = await loadModule({
      design_packages: {
        rows: [{ id: "design-A" }, { id: "design-B" }, { id: "design-C" }],
      },
      listings: {
        rows: [
          { design_package_id: "design-A" },
          { design_package_id: "design-B" },
          { design_package_id: "design-C" },
        ],
        count: 0,
      },
    });

    expect(await mod.getPendingWorkCount("listing")).toBe(0);
  });

  it("returns 0 for scout (no upstream queue)", async () => {
    const { mod } = await loadModule({});

    expect(await mod.getPendingWorkCount("scout")).toBe(0);
    expect(await mod.getPendingWorkCount("ledger")).toBe(0);
  });
});

describe("AGENT_COMMANDS sanity", () => {
  // Catches the class of bug where the spawn args reference an npm script that
  // doesn't exist in the agent's package.json (e.g. "dev" when only "start" is
  // defined). Failure mode without this test: silent at build time, surfaces
  // as a "Spawn failed — see agent_runs for details" red toast at runtime.
  it("references npm scripts that actually exist for each agent's package.json", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const repoRoot = path.resolve(process.cwd(), "..", "..");
    const { AGENT_COMMANDS } = await import("./triggers.config");

    for (const [agent, cmd] of Object.entries(AGENT_COMMANDS)) {
      if (!cmd) continue;
      if (cmd.bin !== "npm") continue;

      // Args shape: ["run", "--workspace", "packages/<name>", "<script>"]
      const runIdx = cmd.args.indexOf("run");
      const wsIdx = cmd.args.indexOf("--workspace");
      expect(runIdx, `${agent}: missing 'run' in args`).toBeGreaterThanOrEqual(0);
      expect(wsIdx, `${agent}: missing '--workspace' in args`).toBeGreaterThanOrEqual(0);

      const workspacePath = cmd.args[wsIdx + 1];
      const scriptName = cmd.args[cmd.args.length - 1];
      expect(workspacePath, `${agent}: missing workspace path`).toBeTruthy();
      expect(scriptName, `${agent}: missing script name`).toBeTruthy();

      const pkgJsonPath = path.join(repoRoot, workspacePath!, "package.json");
      const pkgRaw = await fs.readFile(pkgJsonPath, "utf8");
      const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};

      expect(
        scripts[scriptName!],
        `${agent}: ${workspacePath}/package.json has no script "${scriptName}". ` +
          `Available: ${Object.keys(scripts).join(", ") || "(none)"}.`,
      ).toBeDefined();
    }
  });

  it("references existing Python module entrypoints for VENV_PYTHON agents", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const repoRoot = path.resolve(process.cwd(), "..", "..");
    const { AGENT_COMMANDS } = await import("./triggers.config");

    for (const [agent, cmd] of Object.entries(AGENT_COMMANDS)) {
      if (!cmd) continue;
      if (cmd.bin === "npm") continue;
      // Python args shape: ["-m", "packages.<name>.main"]
      const mIdx = cmd.args.indexOf("-m");
      if (mIdx < 0) continue;
      const moduleSpec = cmd.args[mIdx + 1];
      expect(moduleSpec, `${agent}: missing module after -m`).toBeTruthy();

      const filePath = path.join(repoRoot, `${moduleSpec!.replaceAll(".", "/")}.py`);
      // Resolve via stat — throws if the file doesn't exist, with the agent
      // and resolved path included for actionable test failure output.
      await expect(
        fs.stat(filePath),
        `${agent}: expected module file at ${filePath}`,
      ).resolves.toBeDefined();
    }
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

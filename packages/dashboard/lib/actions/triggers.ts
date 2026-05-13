"use server";

import { spawn } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase/server";
import { requireOwnerEmail } from "@/lib/auth";
import { revalidatePath } from "next/cache";

const AgentSchema = z.enum(["scout", "design", "listing", "ledger"]);
export type Agent = z.infer<typeof AgentSchema>;

/**
 * Core spawn — fire-and-forget local subprocess + agent_runs trail.
 * Returns the agent_runs row id, or null if local triggers are disabled.
 *
 * Internal: doesn't auth-check (callers must). Use `triggerAgent` for the
 * user-facing path or `maybeAutoTrigger` for downstream-chained spawns.
 */
async function spawnAgent(agent: Agent, triggeredBy: string): Promise<string | null> {
  if (process.env.DASHBOARD_LOCAL_TRIGGERS_ENABLED !== "true") return null;

  const cmd = COMMANDS[agent];
  if (!cmd) return null;

  const db = serviceClient();
  const { data: runRow, error: insertErr } = await db
    .from("agent_runs")
    .insert({ agent, triggered_by: triggeredBy })
    .select("id")
    .single();
  if (insertErr || !runRow) {
    return null;
  }
  const runId = runRow.id as string;

  const child = spawn(cmd.bin, cmd.args, {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  child.stdout?.on("data", (chunk) => {
    stdoutBuf += chunk.toString();
    if (stdoutBuf.length > 4096) stdoutBuf = stdoutBuf.slice(-4096);
  });
  child.stderr?.on("data", (chunk) => {
    stderrBuf += chunk.toString();
    if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
  });
  child.on("close", async (code) => {
    try {
      await db
        .from("agent_runs")
        .update({
          finished_at: new Date().toISOString(),
          exit_code: code,
          stdout_tail: stdoutBuf || null,
          stderr_tail: stderrBuf || null,
        })
        .eq("id", runId);
    } catch {
      // metrics-only — never let a write failure crash the spawn callback
    }
  });
  child.on("error", async (err) => {
    try {
      await db
        .from("agent_runs")
        .update({
          finished_at: new Date().toISOString(),
          exit_code: -1,
          stderr_tail: `spawn error: ${err.message}`,
        })
        .eq("id", runId);
    } catch {
      // ignore
    }
  });
  child.unref();

  return runId;
}

/**
 * User-facing trigger from the Run button.
 */
export async function triggerAgent(formData: FormData): Promise<void> {
  const email = await requireOwnerEmail();
  if (!email) throw new Error("Unauthorized");

  if (process.env.DASHBOARD_LOCAL_TRIGGERS_ENABLED !== "true") {
    throw new Error(
      "Local agent triggers are disabled. Set DASHBOARD_LOCAL_TRIGGERS_ENABLED=true in .env and restart, or run the agent from your terminal.",
    );
  }

  const agent = AgentSchema.parse(formData.get("agent"));
  const runId = await spawnAgent(agent, email);
  if (!runId) {
    throw new Error("Spawn failed — see agent_runs for details");
  }

  revalidatePath(`/${agent === "listing" ? "listings" : agent}`);
  revalidatePath("/");
}

/**
 * Called from an approve action to chain into the next agent. Silently no-ops
 * when:
 *   - DASHBOARD_LOCAL_TRIGGERS_ENABLED is unset (e.g. cloud deploy)
 *   - The next agent's `<agent>_manual_mode_enabled` flag is true
 *
 * Either condition just means "the user will run the agent themselves" —
 * the approve action still succeeds.
 */
export async function maybeAutoTrigger(
  agent: Agent,
  triggeredBy: string,
): Promise<void> {
  const email = await requireOwnerEmail();
  if (!email) throw new Error("Unauthorized");

  if (process.env.DASHBOARD_LOCAL_TRIGGERS_ENABLED !== "true") return;

  const db = serviceClient();
  const { data } = await db
    .from("runtime_flags")
    .select("value")
    .eq("key", `${agent}_manual_mode_enabled`)
    .maybeSingle();
  // Manual mode true → user wants to click Run themselves. Bail.
  if (data && data.value === true) return;

  await spawnAgent(agent, triggeredBy);
}

// Repo root is two levels up from `packages/dashboard` (where `cwd` resolves at runtime).
const REPO_ROOT = path.resolve(process.cwd(), "..", "..");
// Use the repo's venv interpreter so Python agents run with project deps,
// not whatever `python` happens to resolve to on system PATH (often Python 2.7 on macOS).
const VENV_PYTHON = path.join(REPO_ROOT, ".venv/bin/python");

const COMMANDS: Record<Agent, { bin: string; args: string[] } | null> = {
  scout: { bin: VENV_PYTHON, args: ["-m", "packages.scout.main"] },
  design: { bin: VENV_PYTHON, args: ["-m", "packages.design.main"] },
  // The listing agent's poller entry point. Adjust if the local dev script
  // diverges from this one.
  listing: { bin: "npm", args: ["run", "--workspace", "packages/listing", "dev"] },
  ledger: { bin: "npm", args: ["run", "--workspace", "packages/ledger", "poll-receipts"] },
};

export interface AgentRunSummary {
  id: string;
  agent: Agent;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  stdout_tail: string | null;
  stderr_tail: string | null;
}

export async function getLastAgentRun(agent: Agent): Promise<AgentRunSummary | null> {
  const email = await requireOwnerEmail();
  if (!email) throw new Error("Unauthorized");

  const db = serviceClient();
  const { data } = await db
    .from("agent_runs")
    .select("*")
    .eq("agent", agent)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as AgentRunSummary | null) ?? null;
}

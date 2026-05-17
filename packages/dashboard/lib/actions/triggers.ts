"use server";

import { spawn } from "node:child_process";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase/server";
import { requireOwnerEmail } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { AGENT_COMMANDS, REPO_ROOT, type Agent } from "./triggers.config";

const AgentSchema = z.enum(["scout", "design", "listing", "ledger"]);
export type { Agent };

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
 * Spawn an agent in direct response to an operator-initiated action on
 * THAT agent's surface — e.g. Design Regen / Re-mask, where the click
 * IS the operator saying "do your job for this row, now". Distinct from
 * `maybeAutoTrigger` (which gated UPSTREAM chains the operator disabled
 * project-wide).
 *
 * Same DASHBOARD_LOCAL_TRIGGERS_ENABLED gate as the user-facing Run
 * button, so cloud deploys (where the env var is unset) still leave the
 * row queued for the next manual / cron-driven run rather than crashing
 * the action.
 *
 * Fire-and-forget: returns the agent_runs id (or null) but callers
 * typically ignore it — the row is already queued in the DB, so a spawn
 * failure just means the operator can click the Run button to drain.
 */
export async function spawnAgentForOperatorAction(
  agent: Agent,
  triggeredBy: string,
): Promise<string | null> {
  return spawnAgent(agent, triggeredBy);
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

// Internal alias retained so the spawn path keeps its old name without a
// rename diff. Either symbol points at the same object exported from
// triggers.config.ts (which lives outside "use server" so it can hold
// non-async exports — Next.js forbids object exports from "use server").
const COMMANDS = AGENT_COMMANDS;

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

/**
 * Count of upstream rows waiting for `agent` to claim. Drives the Run
 * button's gold glow — when > 0 there's something for the agent to do.
 *
 * Mapping mirrors each agent's claim contract:
 *   - design  → trend_briefs at status='approved' (Design's claim RPC)
 *   - listing → design_packages at status='approved' (Listing's claim path)
 *   - scout   → 0 (Scout has no upstream queue; it scans Etsy on demand)
 *   - ledger  → 0 (Ledger is a poller, not gated by approval state)
 *
 * Returns 0 on any DB error so the button silently falls back to its idle
 * state — a missing badge is better than a broken Run page.
 */
export async function getPendingWorkCount(agent: Agent): Promise<number> {
  if (agent !== "design" && agent !== "listing") return 0;

  const email = await requireOwnerEmail();
  if (!email) throw new Error("Unauthorized");

  const db = serviceClient();

  if (agent === "design") {
    // Design's queue is still "approved trend_briefs waiting to be picked up".
    const { count, error } = await db
      .from("trend_briefs")
      .select("id", { count: "exact", head: true })
      .eq("status", "approved");
    if (error) return 0;
    return count ?? 0;
  }

  // Listing's queue is two-part after migration 046:
  //   1. Approved designs that don't yet have a listings row (Phase 3 in
  //      packages/listing/src/index.ts — a fresh claim creates a listings
  //      row).
  //   2. Listings at status='pending' (Phase 2 — operator retries from error,
  //      Recreate Printify product, transient publishOne failures, or fresh
  //      claims from the previous run that haven't been processed yet).
  //
  // Counting just "approved designs" overstates wildly because designs now
  // stay at 'approved' for their lifetime (they no longer transition to
  // 'processing' / 'done' under the new pipeline contract). PostgREST has
  // no cross-table NOT EXISTS, so we pull the two id sets and subtract:
  // approved designs whose id is NOT in the set of design_package_ids
  // referenced by any listings row.
  const [approvedDesigns, linkedDesigns, pendingListings] = await Promise.all([
    db.from("design_packages").select("id").eq("status", "approved"),
    db
      .from("listings")
      .select("design_package_id")
      .not("design_package_id", "is", null),
    db
      .from("listings")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending"),
  ]);
  if (approvedDesigns.error || linkedDesigns.error || pendingListings.error) {
    return 0;
  }
  const linkedIds = new Set(
    (linkedDesigns.data ?? []).map(
      (r) => (r as { design_package_id: string }).design_package_id,
    ),
  );
  const unclaimedApproved = (approvedDesigns.data ?? []).filter(
    (d) => !linkedIds.has((d as { id: string }).id),
  ).length;
  return unclaimedApproved + (pendingListings.count ?? 0);
}

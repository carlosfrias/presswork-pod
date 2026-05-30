"use client";

import { useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { browserClient } from "@/lib/supabase/browser";
import { triggerAgent, type Agent } from "@/lib/actions/triggers";

/**
 * Trigger button for an agent run. Four visual states:
 *
 *   1. IDLE (pendingCount = 0, no run in flight)
 *      Quiet secondary button. Nothing to do.
 *
 *   2. READY (pendingCount > 0, no run in flight)
 *      "Glowing gold radiant" — pulsing accent-warm halo + tinted border so
 *      the operator notices there's work waiting.
 *
 *   3. SUBMITTING (form action mid-submit)
 *      Disabled + spinner + "Running…". Form-status-driven, lasts only the
 *      sub-second it takes the server action to spawn the agent.
 *
 *   4. RUN IN FLIGHT (agent_runs row open for this agent)
 *      No glow + "Working…" label + disabled. This is the fix for the
 *      "click → not gold → gold again" flicker: the click spawns the agent
 *      in a detached subprocess, the server action returns fast (sub-second),
 *      and useFormStatus.pending flips back to false long before the run
 *      actually finishes. Without this state, the glow would come back
 *      because pendingCount is still > 0 (the agent hasn't drained the
 *      queue yet). We watch agent_runs via Supabase realtime to know when
 *      the run is genuinely in flight vs. genuinely done.
 *
 * State precedence (highest → lowest): SUBMITTING > RUN IN FLIGHT > READY > IDLE.
 */
interface Props {
  agent: Agent;
  label: string;
  pendingCount: number;
  /**
   * Hard-disable regardless of Realtime state. Used when a DB-state signal
   * (e.g. listings in 'publishing') confirms the agent is already running,
   * so the button stays locked even if the agent_runs subscription lags.
   */
  locked?: boolean;
  /**
   * Whether this agent has an upstream work queue (design, listing).
   * Queue-less agents (scout, ledger) run on-demand — their button should
   * remain enabled whenever the agent is not already running, regardless of
   * pendingCount (which is always 0 for queue-less agents).
   */
  hasQueue?: boolean;
}

export function TriggerButton({ agent, label, pendingCount, locked = false, hasQueue = false }: Props) {
  const runInFlight = useRunInFlight(agent);

  return (
    <form action={triggerAgent} className="relative">
      <input type="hidden" name="agent" value={agent} />
      <InnerButton
        label={label}
        pendingCount={pendingCount}
        runInFlight={runInFlight || locked}
        hasQueue={hasQueue}
      />
    </form>
  );
}

/**
 * Returns true while an agent_runs row exists for this agent with
 * finished_at IS NULL. Subscribes to realtime INSERT/UPDATE on agent_runs;
 * the in-flight state flips on INSERT (operator clicked, run started) and
 * flips off on UPDATE that sets finished_at (subprocess exited).
 *
 * Initial value is fetched once on mount so the button's state is correct
 * on page load even if no realtime events have fired yet — e.g., operator
 * navigates back to a page mid-run.
 */
function useRunInFlight(agent: Agent): boolean {
  const [inFlight, setInFlight] = useState(false);

  useEffect(() => {
    const supabase = browserClient();
    let cancelled = false;

    async function fetchLatest() {
      const { data } = await supabase
        .from("agent_runs")
        .select("finished_at")
        .eq("agent", agent)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!cancelled) setInFlight(data != null && data.finished_at == null);
    }

    void fetchLatest();

    // The channel name is unique per (agent, browser tab) so subscriptions
    // don't collide with AgentRunStatus' channel for the same agent. Both
    // can listen to the same underlying table; Supabase fans out events to
    // every channel independently.
    const channel = supabase
      .channel(`trigger-button-${agent}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "agent_runs",
          filter: `agent=eq.${agent}`,
        },
        () => void fetchLatest(),
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [agent]);

  return inFlight;
}

function InnerButton({
  label,
  pendingCount,
  runInFlight,
  hasQueue,
}: {
  label: string;
  pendingCount: number;
  runInFlight: boolean;
  hasQueue: boolean;
}) {
  const { pending } = useFormStatus();
  const hasWork = pendingCount > 0;
  // Queue-less agents (scout, ledger) are always considered "ready" — they
  // have no upstream queue so pendingCount is always 0 by design. The only
  // guard that should disable them is being already busy.
  const canSubmit = hasQueue ? hasWork : true;
  const busy = pending || runInFlight;
  const showGlow = hasWork && !busy;

  return (
    <div className="relative inline-block">
      {/* Glow halo. Pulses opacity on a 2s loop via animate-pulse, with a
          strong gold box-shadow that bleeds outward. pointer-events-none
          so it can't intercept clicks. Rendered behind the button via -z-10
          on a positioned wrapper. */}
      {showGlow && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 animate-pulse rounded-(--radius-sm) shadow-[0_0_22px_5px_rgba(244,167,76,0.55)]"
        />
      )}
      <Button
        type="submit"
        variant={showGlow ? "primary" : "secondary"}
        size="sm"
        disabled={busy || !canSubmit}
        className={cn(
          "transition-shadow",
          showGlow && "ring-2 ring-(--accent-warm) ring-offset-2 ring-offset-(--surface-0)",
        )}
        aria-label={
          hasWork ? `${label} (${pendingCount} waiting)` : label
        }
      >
        {pending ? (
          <>
            <Spinner />
            Running…
          </>
        ) : runInFlight ? (
          <>
            <Spinner />
            Working…
          </>
        ) : (
          <>
            {label}
            {hasWork && (
              <span className="ml-1 rounded-full bg-(--surface-0)/25 px-1.5 py-0.5 text-[10px] font-semibold tabular leading-none">
                {pendingCount}
              </span>
            )}
          </>
        )}
      </Button>
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="h-3.5 w-3.5 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
        opacity="0.25"
      />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

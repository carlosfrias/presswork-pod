"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  type Agent,
  type AgentRunSummary,
  getLastAgentRun,
} from "@/lib/actions/triggers";
import { browserClient } from "@/lib/supabase/browser";
import { formatRelative } from "@/lib/format";

// Realtime-driven, not timer-driven. We subscribe to row-level changes on
// `agent_runs` filtered by this badge's agent — every spawn (INSERT) and
// every exit-code-write (UPDATE) triggers a getLastAgentRun() call. No idle
// chatter; the WebSocket is silent until something actually happens.
//
// Safety-net refetch fires every 60s in case the WebSocket drops silently.
// Still a 20-40× reduction vs. the old 1.5s/3s timers, and it shrinks to
// ~zero when the channel is healthy.
const SAFETY_REFETCH_MS = 60_000;

export function AgentRunStatus({
  agent,
  initial,
}: {
  agent: Agent;
  initial: AgentRunSummary | null;
}) {
  const [run, setRun] = useState<AgentRunSummary | null>(initial);
  const router = useRouter();
  const [, startTransition] = useTransition();
  const finishedNotifiedRef = useRef<string | null>(
    initial?.finished_at != null ? initial.id : null,
  );
  // formatRelative() reads Date.now(), so it diverges between SSR and client
  // hydration. Gate the time suffix on a mounted flag so first paint matches
  // the server-rendered HTML.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // Server-rendered initial value can change when the parent revalidates
  // (e.g. after the trigger action). Sync it in if it's newer — never step
  // back to an older row mid-stream.
  useEffect(() => {
    setRun((current) => {
      if (initial == null) return current ?? initial;
      if (current == null) return initial;
      return initial.started_at >= current.started_at ? initial : current;
    });
  }, [initial]);

  useEffect(() => {
    let cancelled = false;

    const refetch = async () => {
      try {
        const next = await getLastAgentRun(agent);
        if (cancelled || next == null) return;
        setRun((current) => {
          // Only accept rows that are >= what we already have — never regress.
          if (current == null) return next;
          if (next.started_at < current.started_at) return current;
          return next;
        });
        // First time we observe finished_at on this run id → refresh adjacent
        // server components so trend_briefs / design_packages updates show up.
        if (
          next.finished_at != null &&
          finishedNotifiedRef.current !== next.id
        ) {
          finishedNotifiedRef.current = next.id;
          startTransition(() => router.refresh());
        }
      } catch {
        // Next event / safety tick retries.
      }
    };

    const supabase = browserClient();
    let channel: ReturnType<typeof supabase.channel> | null = null;

    // Auth-first connect: see RealtimeRefresh.tsx for the full rationale.
    // setAuth() must land before subscribe() or the channel joins as anon
    // and server-side RLS drops every event from agent_runs_read_allowlist.
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      if (data.session?.access_token) {
        await supabase.realtime.setAuth(data.session.access_token);
      }
      if (cancelled) return;

      channel = supabase
        .channel(`agent-runs-${agent}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "agent_runs",
            filter: `agent=eq.${agent}`,
          },
          () => void refetch(),
        )
        .subscribe();
    })();

    // Safety-net heartbeat for dropped WebSockets in long-lived tabs.
    const safetyTimer = setInterval(() => void refetch(), SAFETY_REFETCH_MS);

    return () => {
      cancelled = true;
      clearInterval(safetyTimer);
      if (channel) supabase.removeChannel(channel);
    };
  }, [agent, router]);

  if (!run) {
    return <span className="text-[11px] text-(--text-faint)">no runs yet</span>;
  }

  const exit = run.exit_code;
  const ok = exit === 0;
  const inFlight = run.finished_at == null;
  const timeSuffix = mounted ? ` · ${formatRelative(run.finished_at)}` : "";
  const label = inFlight ? "running…" : `exit ${exit}${timeSuffix}`;
  const color = inFlight
    ? "text-(--accent-warm)"
    : ok
      ? "text-(--accent-good)"
      : "text-(--accent-bad)";
  return <span className={`text-[11px] tabular ${color}`}>{label}</span>;
}

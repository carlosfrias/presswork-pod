"use client";

import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { browserClient } from "@/lib/supabase/browser";

/**
 * Side-effect-only mount: subscribes to row-level changes on a Postgres
 * table and calls router.refresh() to re-fetch the page's server
 * components.
 *
 * Use this to live-update page surfaces driven by an agent that walks rows
 * through status transitions (Design: pending → processing → needs_review,
 * Listings: pending → needs_review → publishing → active). Without it the
 * operator sees a frozen page mid-run and has to refresh manually.
 *
 * Debounced: a single agent pass can touch the same row 3–4 times in
 * seconds (status, image_url, mockups, etc.). The 250 ms window collapses
 * a burst into a single re-render — still feels live, doesn't thrash.
 *
 * Renders nothing — the only output is the side effect.
 *
 * The target table MUST be in the supabase_realtime publication and have
 * RLS policies that permit the owner-email session to SELECT the rows
 * (migrations 031 and the per-table ADD migrations). Without those two,
 * the subscription succeeds silently but no events arrive.
 */
interface Props {
  table: string;
  channelName: string;
}

export function RealtimeRefresh({ table, channelName }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const supabase = browserClient();
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    function scheduleRefresh() {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        startTransition(() => router.refresh());
      }, 250);
    }

    // Auth-first connect: hand the access token to the realtime client BEFORE
    // joining any channels. supabase-js normally syncs auth into realtime via
    // onAuthStateChange, but the first useEffect-run on a fresh page load
    // races ahead of that wiring — if subscribe fires before the token lands
    // the channel joins as anon and server-side RLS drops every event
    // silently (the _read_allowlist policies require auth.jwt() to resolve
    // to an allowlisted email).
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      if (data.session?.access_token) {
        await supabase.realtime.setAuth(data.session.access_token);
      }
      if (cancelled) return;

      channel = supabase
        .channel(channelName)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table },
          scheduleRefresh,
        )
        .subscribe();
    })();

    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [router, table, channelName]);

  return null;
}

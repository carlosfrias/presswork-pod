"use client";

import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser-side anon client. Used only for Realtime subscriptions and for the
 * Supabase Auth magic-link callback exchange. Never used for data writes — all
 * mutations go through Server Actions which use the service-role client.
 */
export function browserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set");
  }
  return createBrowserClient(url, key);
}

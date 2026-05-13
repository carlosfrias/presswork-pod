import "server-only";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

type CookieToSet = { name: string; value: string; options: CookieOptions };

/**
 * Service-role client. Use for everything the dashboard reads or writes.
 * Never importable from a client component — `server-only` enforces that at
 * build time. Auth is handled at the middleware boundary (email allowlist),
 * not via Postgres RLS.
 */
export function serviceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Auth-scoped server client used only for Supabase Auth session reads/writes
 * (cookies on `next/headers`). All data queries should still go through
 * `serviceClient()` — auth here is just to identify *who* is asking.
 */
export async function authServerClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set");
  }
  const cookieStore = await cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet: CookieToSet[]) => {
        try {
          toSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Called from a Server Component — Next forbids mutating cookies
          // outside Route Handlers / Server Actions. Safe to ignore; the
          // middleware refreshes the session on the next request.
        }
      },
    },
  });
}

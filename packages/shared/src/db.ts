import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { getSettings } from "./config.js";

export type Db = SupabaseClient;

let _cached: Db | undefined;

function isServiceRoleKey(key: string): boolean {
  // Supabase CLI v2.99+ uses sb_secret_… short-form keys instead of JWTs.
  if (key.startsWith("sb_secret_")) return true;

  // Production keys are JWTs — decode the payload and check the role claim.
  const parts = key.split(".");
  if (parts.length !== 3 || !parts[1]) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      role?: string;
    };
    return payload.role === "service_role";
  } catch {
    return false;
  }
}

export function getDb(): Db {
  if (_cached) return _cached;

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSettings();

  if (!isServiceRoleKey(SUPABASE_SERVICE_ROLE_KEY)) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY does not appear to be a service role key. " +
        "Expected an sb_secret_… short-form key or a JWT with role=\"service_role\". " +
        "Did you pass the anon key by mistake?"
    );
  }

  _cached = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  return _cached;
}

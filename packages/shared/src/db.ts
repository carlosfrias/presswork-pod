import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { getSettings } from "./config.js";

export type Db = SupabaseClient;

let _cached: Db | undefined;

export function getDb(): Db {
  if (_cached) return _cached;

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSettings();

  // Verify the key is a service role JWT, not the anon key
  const parts = SUPABASE_SERVICE_ROLE_KEY.split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY does not look like a JWT");
  }
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
    role?: string;
  };
  if (payload.role !== "service_role") {
    throw new Error(
      `SUPABASE_SERVICE_ROLE_KEY has role="${payload.role}" — expected "service_role". Did you pass the anon key by mistake?`
    );
  }

  _cached = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  return _cached;
}

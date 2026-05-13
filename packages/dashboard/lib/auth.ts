import "server-only";
import { authServerClient } from "./supabase/server";

function parseAllowlist(): string[] {
  return (process.env.DASHBOARD_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowed(email: string | null | undefined): boolean {
  if (!email) return false;
  const allow = parseAllowlist();
  if (allow.length === 0) return false;
  return allow.includes(email.toLowerCase());
}

export async function getSessionEmail(): Promise<string | null> {
  const supabase = await authServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.email ?? null;
}

/** Returns null when not signed in OR not on the allowlist. */
export async function requireOwnerEmail(): Promise<string | null> {
  const email = await getSessionEmail();
  return isAllowed(email) ? email : null;
}

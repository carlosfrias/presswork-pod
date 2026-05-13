import { authServerClient } from "@/lib/supabase/server";
import { isAllowed } from "@/lib/auth";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Magic-link callback. Exchanges the code for a session, then enforces the
 * email allowlist. Allowlist failures end the session and redirect back to
 * /login with a flag.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const rawNext = url.searchParams.get("next") ?? "/";
  // Only accept same-origin relative paths. Protocol-relative `//evil.com` and
  // absolute URLs both bypass `new URL(_, origin)`'s base, so reject anything
  // that doesn't start with a single `/`.
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";

  if (!code) {
    return NextResponse.redirect(new URL("/login?error=missing_code", url.origin));
  }

  const supabase = await authServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(error.message)}`, url.origin));
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!isAllowed(user?.email)) {
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL("/login?error=not_allowed", url.origin));
  }

  return NextResponse.redirect(new URL(next, url.origin));
}

import { type NextRequest, NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Aggregated dashboard health.
 *
 * Default unauthenticated response: `{ ok, db, now }` — confirms the
 * dashboard can reach Supabase, without leaking operational signal
 * (per-agent error counts) to any caller. Single-operator deployment
 * makes the previous full payload low-impact, but unnecessarily public
 * (AUDIT_4 H6).
 *
 * Detailed payload (per-agent error counts) is gated behind an optional
 * bearer token. Set `HEALTHZ_BEARER` in Railway env to enable; leave
 * unset to keep the trimmed default behavior for everyone.
 *
 * A wrong/missing bearer is silently downgraded to the trimmed payload
 * — there is no timing or status-code signal that the bearer was tried.
 */
export async function GET(req: NextRequest) {
  const db = serviceClient();
  try {
    // Reachability ping — single round-trip, no row counts in the payload.
    const { error: pingErr } = await db
      .from("trend_briefs")
      .select("id", { count: "exact", head: true })
      .limit(1);
    if (pingErr) throw pingErr;

    const base = {
      ok: true,
      db: "ok",
      now: new Date().toISOString(),
    };

    const expected = process.env["HEALTHZ_BEARER"];
    const provided = req.headers.get("authorization");
    const matches =
      Boolean(expected) && provided === `Bearer ${expected}`;
    if (!matches) {
      return NextResponse.json(base);
    }

    // Authorized — include per-agent open-error counts for quick triage.
    const [briefs, designs, listings, orders] = await Promise.all([
      db.from("trend_briefs").select("id", { count: "exact", head: true }).eq("status", "error"),
      db.from("design_packages").select("id", { count: "exact", head: true }).eq("status", "error"),
      db.from("listings").select("id", { count: "exact", head: true }).eq("status", "error"),
      db.from("orders").select("id", { count: "exact", head: true }).eq("status", "error"),
    ]);
    return NextResponse.json({
      ...base,
      error_counts: {
        scout: briefs.count ?? 0,
        design: designs.count ?? 0,
        listing: listings.count ?? 0,
        ledger: orders.count ?? 0,
      },
    });
  } catch {
    // Public endpoint — never leak Supabase error details.
    return NextResponse.json({ ok: false, db: "error" }, { status: 500 });
  }
}

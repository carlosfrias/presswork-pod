import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Aggregated dashboard health.
 * - db: can we reach Supabase and read counts?
 * - error_counts: open errors per agent table (quick triage signal)
 * Printify in-memory ring lives on the agent processes themselves, so it's
 * not visible here. A Phase 2 follow-up will expose `/healthz` on each Railway
 * service and aggregate it through this endpoint.
 */
export async function GET() {
  const db = serviceClient();
  try {
    const [briefs, designs, listings, orders] = await Promise.all([
      db.from("trend_briefs").select("id", { count: "exact", head: true }).eq("status", "error"),
      db.from("design_packages").select("id", { count: "exact", head: true }).eq("status", "error"),
      db.from("listings").select("id", { count: "exact", head: true }).eq("status", "error"),
      db.from("orders").select("id", { count: "exact", head: true }).eq("status", "error"),
    ]);
    return NextResponse.json({
      ok: true,
      db: "ok",
      error_counts: {
        scout: briefs.count ?? 0,
        design: designs.count ?? 0,
        listing: listings.count ?? 0,
        ledger: orders.count ?? 0,
      },
      now: new Date().toISOString(),
    });
  } catch {
    // `/api/healthz` is intentionally public; never leak Supabase error
    // details (table/column names, connection strings) to unauthenticated
    // callers. Operators inspect server logs for the underlying error.
    return NextResponse.json({ ok: false, db: "error" }, { status: 500 });
  }
}

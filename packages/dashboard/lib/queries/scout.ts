import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import type { StatusCount } from "@/components/status/StatusFunnel";
import type { TrendBriefRow } from "./types";

export async function getScoutStatusCounts(): Promise<StatusCount[]> {
  const db = serviceClient();
  // Order matches the human-gated flow: needs_review → approved → processing → done → error
  const statuses = ["needs_review", "approved", "processing", "done", "error"] as const;
  const results = await Promise.all(
    statuses.map((status) =>
      db.from("trend_briefs").select("id", { count: "exact", head: true }).eq("status", status),
    ),
  );
  return statuses.map((status, i) => ({ status, count: results[i].count ?? 0 }));
}

export async function getBriefReviewQueue(): Promise<TrendBriefRow[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("trend_briefs")
    .select("*")
    .eq("status", "needs_review")
    .order("created_at", { ascending: true }); // oldest first — fairest queue
  if (error) {
    console.error("getBriefReviewQueue failed", error);
    return [];
  }
  return (data ?? []) as TrendBriefRow[];
}

/**
 * Full brief history. Capped at 500 for now — once we routinely exceed that,
 * swap the page over to a paginated cursor query (created_at < last_seen).
 */
export async function getAllBriefs(limit = 500): Promise<TrendBriefRow[]> {
  return getRecentBriefs(limit);
}

export async function getRecentBriefs(limit = 20): Promise<TrendBriefRow[]> {
  const db = serviceClient();
  // Over-fetch so the post-filter still returns `limit` rows even when a
  // chunk of recent briefs are Builder-spawned children. 5× covers a heavy
  // Builder session without growing the query meaningfully (the table is
  // small and indexed on created_at).
  const { data, error } = await db
    .from("trend_briefs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit * 5);
  if (error) {
    console.error("getRecentBriefs failed", error);
    return [];
  }
  // Hide Builder-spawned children — they clutter the recent list with
  // duplicate-looking rows per niche. The parent brief is what represents
  // the trend signal; children are downstream design forks and surface
  // anyway on the Design page.
  const filtered = (data ?? []).filter((row) => {
    const analysis = (row as { claude_analysis?: unknown }).claude_analysis;
    if (!analysis || typeof analysis !== "object") return true;
    const source = (analysis as { source?: unknown }).source;
    return source !== "builder_spawn";
  });
  return filtered.slice(0, limit) as TrendBriefRow[];
}

export interface NichePerformance {
  niche: string;
  briefs: number;
  designs: number;
  listings_active: number;
  revenue_usd: number;
  margin_usd: number;
}

export async function getNichePerformance(limit = 20): Promise<NichePerformance[]> {
  const db = serviceClient();
  // Pull briefs with their downstream chain and aggregate in memory. Row
  // counts are small (hundreds, not millions), so this beats writing four
  // separate aggregations.
  const { data, error } = await db
    .from("trend_briefs")
    .select(
      `niche,
       design_packages:design_packages!design_packages_trend_brief_id_fkey(
         id, status,
         listings:listings(id, is_active,
           orders:orders(sale_price_usd, margin_usd)
         )
       )`,
    )
    .order("created_at", { ascending: false })
    .limit(500);
  if (error || !data) {
    console.error("getNichePerformance failed", error);
    return [];
  }

  type Brief = {
    niche: string;
    design_packages: {
      id: string;
      status: string;
      listings: {
        id: string;
        is_active: boolean;
        orders: { sale_price_usd: number | null; margin_usd: number | null }[] | null;
      }[] | null;
    }[] | null;
  };

  const byNiche = new Map<string, NichePerformance>();
  for (const row of data as Brief[]) {
    const slot = byNiche.get(row.niche) ?? {
      niche: row.niche,
      briefs: 0,
      designs: 0,
      listings_active: 0,
      revenue_usd: 0,
      margin_usd: 0,
    };
    slot.briefs += 1;
    for (const dp of row.design_packages ?? []) {
      if (dp.status === "done") slot.designs += 1;
      for (const l of dp.listings ?? []) {
        if (l.is_active) slot.listings_active += 1;
        for (const o of l.orders ?? []) {
          slot.revenue_usd += Number(o.sale_price_usd ?? 0);
          slot.margin_usd += Number(o.margin_usd ?? 0);
        }
      }
    }
    byNiche.set(row.niche, slot);
  }

  return [...byNiche.values()]
    .sort((a, b) => b.revenue_usd - a.revenue_usd || b.briefs - a.briefs)
    .slice(0, limit);
}

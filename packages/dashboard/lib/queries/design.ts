import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import type { DesignPackageRow, TrendBriefRow } from "./types";

export interface DesignReviewItem extends DesignPackageRow {
  trend_brief: Pick<TrendBriefRow, "id" | "niche" | "color_palette"> | null;
}

export async function getDesignReviewQueue(): Promise<DesignReviewItem[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("design_packages")
    .select(
      `*,
       trend_briefs:trend_briefs!design_packages_trend_brief_id_fkey(id, niche, color_palette)`,
    )
    .eq("status", "needs_review")
    .order("created_at", { ascending: true });
  if (error || !data) {
    console.error("getDesignReviewQueue failed", error);
    return [];
  }
  type Row = DesignPackageRow & {
    trend_briefs: Pick<TrendBriefRow, "id" | "niche" | "color_palette"> | null;
  };
  return (data as Row[]).map((r) => ({
    ...r,
    trend_brief: r.trend_briefs ?? null,
  }));
}

export async function getRecentDesigns(limit = 24): Promise<DesignPackageRow[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("design_packages")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("getRecentDesigns failed", error);
    return [];
  }
  return (data ?? []) as DesignPackageRow[];
}

export interface DesignSpend {
  flux_pro_usd: number;
  aura_sr_usd: number;
  birefnet_usd: number;
  total_usd: number;
  designs_done: number;
  avg_cost_per_design: number | null;
  cache_hits: number;
}

export async function getDesignSpend(windowDays: number): Promise<DesignSpend> {
  const db = serviceClient();
  const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000).toISOString();

  const { data: usage } = await db
    .from("llm_usage")
    .select("operation, cost_usd, metadata")
    .eq("provider", "fal")
    .gte("created_at", since);

  const spend = { flux_pro_usd: 0, aura_sr_usd: 0, birefnet_usd: 0, total_usd: 0 };
  let cache_hits = 0;
  for (const row of (usage ?? []) as { operation: string; cost_usd: number | null; metadata: { cache_hit?: boolean } | null }[]) {
    const cost = Number(row.cost_usd ?? 0);
    spend.total_usd += cost;
    if (row.operation.startsWith("flux")) spend.flux_pro_usd += cost;
    else if (row.operation.startsWith("aura")) spend.aura_sr_usd += cost;
    else if (row.operation.startsWith("birefnet")) spend.birefnet_usd += cost;
    if (row.metadata?.cache_hit) cache_hits += 1;
  }

  const { count: designsCount } = await db
    .from("design_packages")
    .select("id", { count: "exact", head: true })
    .eq("status", "done")
    .gte("created_at", since);

  const designs_done = designsCount ?? 0;
  return {
    ...spend,
    designs_done,
    avg_cost_per_design: designs_done ? spend.total_usd / designs_done : null,
    cache_hits,
  };
}

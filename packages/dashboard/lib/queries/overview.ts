import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import type { DailySummaryRow, RuntimeFlagRow } from "./types";

export interface OverviewKpis {
  windowDays: number;
  revenue_usd: number;
  margin_usd: number;
  order_count: number;
  listings_published: number;
  designs: number;
  briefs: number;
  fal_spend_usd: number;
  anthropic_spend_usd: number;
  etsy_fees_usd: number;
}

const ZERO_KPIS = (windowDays: number): OverviewKpis => ({
  windowDays,
  revenue_usd: 0,
  margin_usd: 0,
  order_count: 0,
  listings_published: 0,
  designs: 0,
  briefs: 0,
  fal_spend_usd: 0,
  anthropic_spend_usd: 0,
  etsy_fees_usd: 0,
});

export async function getDailySummary(days: number = 30): Promise<DailySummaryRow[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("dashboard_daily_summary")
    .select("*")
    .order("day", { ascending: true })
    .limit(days);
  if (error) {
    console.error("getDailySummary failed", error);
    return [];
  }
  return (data ?? []) as DailySummaryRow[];
}

export async function getKpis(windowDays: number): Promise<OverviewKpis> {
  const rows = await getDailySummary(windowDays);
  if (rows.length === 0) return ZERO_KPIS(windowDays);
  return rows.reduce<OverviewKpis>((acc, r) => {
    acc.revenue_usd += Number(r.revenue_usd) || 0;
    acc.margin_usd += Number(r.margin_usd) || 0;
    acc.order_count += Number(r.order_count) || 0;
    acc.listings_published += Number(r.listings_published) || 0;
    acc.designs += Number(r.designs) || 0;
    acc.briefs += Number(r.briefs) || 0;
    acc.fal_spend_usd += Number(r.fal_spend_usd) || 0;
    acc.anthropic_spend_usd += Number(r.anthropic_spend_usd) || 0;
    acc.etsy_fees_usd += Number(r.etsy_fees_usd) || 0;
    return acc;
  }, ZERO_KPIS(windowDays));
}

export interface PipelineHealth {
  agent: "scout" | "design" | "listing" | "ledger";
  /** Items waiting for human approval — the most actionable signal. */
  needs_review: number;
  /** Approved by user, waiting for the next agent to claim. */
  approved: number;
  /** Currently being worked on by an agent. */
  processing: number;
  error: number;
  total: number;
}

async function countByStatus(
  table: string,
  statuses: string[],
): Promise<Record<string, number>> {
  const db = serviceClient();
  const out: Record<string, number> = {};
  await Promise.all(
    statuses.map(async (s) => {
      const { count } = await db
        .from(table)
        .select("id", { count: "exact", head: true })
        .eq("status", s);
      out[s] = count ?? 0;
    }),
  );
  return out;
}

export async function getPipelineHealth(): Promise<PipelineHealth[]> {
  const [briefs, designs, listings, orders] = await Promise.all([
    countByStatus("trend_briefs", ["needs_review", "approved", "processing", "error"]),
    countByStatus("design_packages", ["needs_review", "approved", "processing", "error"]),
    countByStatus("listings", ["pending", "needs_review", "pending_publish", "publishing", "error"]),
    countByStatus("orders", ["logged", "error"]),
  ]);

  return [
    {
      agent: "scout",
      needs_review: briefs.needs_review ?? 0,
      approved: briefs.approved ?? 0,
      processing: briefs.processing ?? 0,
      error: briefs.error ?? 0,
      total:
        (briefs.needs_review ?? 0) +
        (briefs.approved ?? 0) +
        (briefs.processing ?? 0) +
        (briefs.error ?? 0),
    },
    {
      agent: "design",
      needs_review: designs.needs_review ?? 0,
      approved: designs.approved ?? 0,
      processing: designs.processing ?? 0,
      error: designs.error ?? 0,
      total:
        (designs.needs_review ?? 0) +
        (designs.approved ?? 0) +
        (designs.processing ?? 0) +
        (designs.error ?? 0),
    },
    {
      agent: "listing",
      // Listings already had its own review gate so its needs_review is the
      // same human-action signal as the new gates on scout/design.
      needs_review: listings.needs_review ?? 0,
      approved: listings.pending_publish ?? 0,
      processing: (listings.pending ?? 0) + (listings.publishing ?? 0),
      error: listings.error ?? 0,
      total:
        (listings.pending ?? 0) +
        (listings.needs_review ?? 0) +
        (listings.pending_publish ?? 0) +
        (listings.publishing ?? 0) +
        (listings.error ?? 0),
    },
    {
      agent: "ledger",
      needs_review: 0,
      approved: 0,
      processing: orders.logged ?? 0,
      error: orders.error ?? 0,
      total: (orders.logged ?? 0) + (orders.error ?? 0),
    },
  ];
}

export interface RecentError {
  source: "trend_briefs" | "design_packages" | "listings" | "orders";
  id: string;
  updated_at: string;
  error_message: string | null;
  href: string;
}

export async function getRecentErrors(limit = 10): Promise<RecentError[]> {
  const db = serviceClient();
  const sources: { table: RecentError["source"]; href: (id: string) => string }[] = [
    { table: "trend_briefs", href: () => `/scout` },
    { table: "design_packages", href: () => `/design` },
    { table: "listings", href: (id) => `/listings/${id}` },
    { table: "orders", href: () => `/ledger` },
  ];
  const rows: RecentError[] = [];
  for (const { table, href } of sources) {
    const { data, error } = await db
      .from(table)
      .select("id, updated_at, error_message")
      .eq("status", "error")
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (error || !data) continue;
    for (const r of data as { id: string; updated_at: string; error_message: string | null }[]) {
      rows.push({
        source: table,
        id: r.id,
        updated_at: r.updated_at,
        error_message: r.error_message,
        href: href(r.id),
      });
    }
  }
  rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return rows.slice(0, limit);
}

/** A single error row from any pipeline table, enriched for the triage view. */
export interface ErrorTriageRow extends RecentError {
  /** Human-readable context string, e.g. the niche for a brief or the title for a listing. */
  context: string | null;
  /** How many times this row has already been retried. */
  retry_count: number;
  /** Whether a one-click requeue is available (false for orders — Ledger re-polls automatically). */
  requeueable: boolean;
}

/**
 * Fetch every error row (up to 200 per table) across all four pipeline tables,
 * sorted newest-first. Per-table errors are logged and skipped rather than
 * aborting the whole query.
 */
export async function getAllErrors(): Promise<ErrorTriageRow[]> {
  const db = serviceClient();

  type SourceConfig = {
    table: RecentError["source"];
    href: (id: string) => string;
    /** Extra columns to select beyond the shared set. */
    extraCols: string;
    /** Extract a human-readable label from the raw row. */
    contextLabel: (row: Record<string, unknown>) => string | null;
    requeueable: boolean;
  };

  const sources: SourceConfig[] = [
    {
      table: "trend_briefs",
      href: () => "/scout",
      extraCols: ", niche",
      contextLabel: (r) => (typeof r.niche === "string" ? r.niche : null),
      requeueable: true,
    },
    {
      table: "design_packages",
      href: () => "/design",
      extraCols: "",
      contextLabel: () => null,
      requeueable: true,
    },
    {
      table: "listings",
      href: (id) => `/listings/${id}`,
      extraCols: ", title",
      contextLabel: (r) => (typeof r.title === "string" ? r.title : null),
      requeueable: true,
    },
    {
      table: "orders",
      href: () => "/ledger",
      extraCols: "",
      contextLabel: () => null,
      requeueable: false,
    },
  ];

  const rowSets = await Promise.all(
    sources.map(async ({ table, href, extraCols, contextLabel, requeueable }) => {
      const { data, error } = await db
        .from(table)
        .select(`id, updated_at, error_message, retry_count${extraCols}`)
        .eq("status", "error")
        .order("updated_at", { ascending: false })
        .limit(200);

      if (error || !data) {
        console.error(`getAllErrors: query failed for ${table}`, error);
        return [] as ErrorTriageRow[];
      }

      return (data as unknown as Record<string, unknown>[]).map((r): ErrorTriageRow => ({
        source: table,
        id: r.id as string,
        updated_at: r.updated_at as string,
        error_message: typeof r.error_message === "string" ? r.error_message : null,
        href: href(r.id as string),
        context: contextLabel(r),
        retry_count: typeof r.retry_count === "number" ? r.retry_count : 0,
        requeueable,
      }));
    }),
  );

  const all = rowSets.flat();
  all.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return all;
}

export async function getRuntimeFlags(): Promise<RuntimeFlagRow[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("runtime_flags")
    .select("*")
    .order("key");
  if (error) {
    console.error("getRuntimeFlags failed", error);
    return [];
  }
  return (data ?? []) as RuntimeFlagRow[];
}

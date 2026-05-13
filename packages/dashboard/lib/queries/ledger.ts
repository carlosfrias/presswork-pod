import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import type { OrderRow } from "./types";

export interface LedgerKpis {
  windowDays: number;
  revenue_usd: number;
  margin_usd: number;
  etsy_fees_usd: number;
  print_cost_usd: number;
  order_count: number;
  error_count: number;
}

export async function getLedgerKpis(windowDays: number): Promise<LedgerKpis> {
  const db = serviceClient();
  const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000).toISOString();
  const { data } = await db
    .from("orders")
    .select("status, sale_price_usd, margin_usd, etsy_fees_usd, print_cost_usd")
    .gte("created_at", since);

  const kpi: LedgerKpis = {
    windowDays,
    revenue_usd: 0,
    margin_usd: 0,
    etsy_fees_usd: 0,
    print_cost_usd: 0,
    order_count: 0,
    error_count: 0,
  };
  for (const o of (data ?? []) as Pick<
    OrderRow,
    "status" | "sale_price_usd" | "margin_usd" | "etsy_fees_usd" | "print_cost_usd"
  >[]) {
    if (o.status === "error") {
      kpi.error_count += 1;
      continue;
    }
    kpi.order_count += 1;
    kpi.revenue_usd += Number(o.sale_price_usd ?? 0);
    kpi.margin_usd += Number(o.margin_usd ?? 0);
    kpi.etsy_fees_usd += Number(o.etsy_fees_usd ?? 0);
    kpi.print_cost_usd += Number(o.print_cost_usd ?? 0);
  }
  return kpi;
}

export interface OrderWithListing extends OrderRow {
  listing_title: string | null;
  listing_etsy_id: number | null;
}

export async function getRecentOrders(limit = 30): Promise<OrderWithListing[]> {
  const db = serviceClient();
  type Row = OrderRow & {
    listings: { title: string | null; etsy_listing_id: number | null } | null;
  };
  const { data, error } = await db
    .from("orders")
    .select(`*, listings:listings(title, etsy_listing_id)`)
    .order("created_at", { ascending: false })
    .limit(limit)
    .returns<Row[]>();
  if (error || !data) {
    console.error("getRecentOrders failed", error);
    return [];
  }
  return data.map((r) => ({
    ...r,
    listing_title: r.listings?.title ?? null,
    listing_etsy_id: r.listings?.etsy_listing_id ?? null,
  }));
}

export interface MarginBucket {
  bucket: string;
  lower: number;
  upper: number;
  count: number;
}

export async function getMarginDistribution(windowDays = 90): Promise<MarginBucket[]> {
  const db = serviceClient();
  const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000).toISOString();
  const { data } = await db
    .from("orders")
    .select("margin_usd")
    .eq("status", "logged")
    .gte("created_at", since)
    .not("margin_usd", "is", null);

  const margins = (data ?? []).map((r) => Number((r as { margin_usd: number | null }).margin_usd ?? 0));
  if (margins.length === 0) return [];

  const buckets: { lower: number; upper: number; label: string }[] = [
    { lower: -Infinity, upper: 0, label: "< $0" },
    { lower: 0, upper: 2, label: "$0–2" },
    { lower: 2, upper: 5, label: "$2–5" },
    { lower: 5, upper: 8, label: "$5–8" },
    { lower: 8, upper: 12, label: "$8–12" },
    { lower: 12, upper: Infinity, label: "$12+" },
  ];
  return buckets.map((b) => ({
    bucket: b.label,
    lower: b.lower,
    upper: b.upper,
    count: margins.filter((m) => m >= b.lower && m < b.upper).length,
  }));
}

export interface TopListing {
  listing_id: string | null;
  title: string | null;
  etsy_listing_id: number | null;
  order_count: number;
  revenue_usd: number;
  margin_usd: number;
}

export async function getTopListings(limit = 10, windowDays = 30): Promise<TopListing[]> {
  const db = serviceClient();
  const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000).toISOString();
  type Row = {
    listing_id: string | null;
    sale_price_usd: number | null;
    margin_usd: number | null;
    listings: { title: string | null; etsy_listing_id: number | null } | null;
  };
  const { data } = await db
    .from("orders")
    .select(
      `listing_id, sale_price_usd, margin_usd,
       listings:listings(title, etsy_listing_id)`,
    )
    .eq("status", "logged")
    .gte("created_at", since)
    .returns<Row[]>();

  const agg = new Map<string, TopListing>();
  for (const r of data ?? []) {
    const key = r.listing_id ?? "_unknown";
    const slot = agg.get(key) ?? {
      listing_id: r.listing_id,
      title: r.listings?.title ?? null,
      etsy_listing_id: r.listings?.etsy_listing_id ?? null,
      order_count: 0,
      revenue_usd: 0,
      margin_usd: 0,
    };
    slot.order_count += 1;
    slot.revenue_usd += Number(r.sale_price_usd ?? 0);
    slot.margin_usd += Number(r.margin_usd ?? 0);
    agg.set(key, slot);
  }
  return [...agg.values()]
    .sort((a, b) => b.revenue_usd - a.revenue_usd)
    .slice(0, limit);
}

export interface BreakdownRow {
  key: string;
  count: number;
  revenue_usd: number;
}

export async function getCurrencyBreakdown(windowDays = 30): Promise<BreakdownRow[]> {
  const db = serviceClient();
  const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000).toISOString();
  const { data } = await db
    .from("orders")
    .select("currency_code, sale_price_usd")
    .eq("status", "logged")
    .gte("created_at", since);

  const agg = new Map<string, BreakdownRow>();
  for (const r of (data ?? []) as { currency_code: string; sale_price_usd: number | null }[]) {
    const slot = agg.get(r.currency_code) ?? { key: r.currency_code, count: 0, revenue_usd: 0 };
    slot.count += 1;
    slot.revenue_usd += Number(r.sale_price_usd ?? 0);
    agg.set(r.currency_code, slot);
  }
  return [...agg.values()].sort((a, b) => b.revenue_usd - a.revenue_usd);
}

export async function getBelowThresholdOrders(
  threshold: number,
  limit = 25,
): Promise<OrderWithListing[]> {
  const db = serviceClient();
  type Row = OrderRow & {
    listings: { title: string | null; etsy_listing_id: number | null } | null;
  };
  const { data, error } = await db
    .from("orders")
    .select(`*, listings:listings(title, etsy_listing_id)`)
    .eq("status", "logged")
    .lt("margin_usd", threshold)
    .order("margin_usd", { ascending: true })
    .limit(limit)
    .returns<Row[]>();
  if (error || !data) {
    console.error("getBelowThresholdOrders failed", error);
    return [];
  }
  return data.map((r) => ({
    ...r,
    listing_title: r.listings?.title ?? null,
    listing_etsy_id: r.listings?.etsy_listing_id ?? null,
  }));
}

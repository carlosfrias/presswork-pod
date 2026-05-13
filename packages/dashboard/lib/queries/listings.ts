import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import type { StatusCount } from "@/components/status/StatusFunnel";
import type { DesignPackageRow, ListingRow, TrendBriefRow } from "./types";

const LISTING_STATUSES = [
  "pending",
  "needs_review",
  "pending_publish",
  "publishing",
  "active",
  "error",
] as const;

export async function getListingStatusCounts(): Promise<StatusCount[]> {
  const db = serviceClient();
  const results = await Promise.all(
    LISTING_STATUSES.map((status) =>
      db.from("listings").select("id", { count: "exact", head: true }).eq("status", status),
    ),
  );
  return LISTING_STATUSES.map((status, i) => ({ status, count: results[i].count ?? 0 }));
}

export async function getNeedsReviewQueue(): Promise<ListingWithDesign[]> {
  return getListingsByStatus("needs_review", 50);
}

export interface ListingWithDesign extends ListingRow {
  design_packages: Pick<
    DesignPackageRow,
    "id" | "image_url" | "mockup_urls" | "printify_blueprint_id" | "mockups_from_actual_design"
  > | null;
  trend_brief: Pick<TrendBriefRow, "id" | "niche"> | null;
}

export async function getListingsByStatus(
  status: ListingRow["status"],
  limit = 30,
): Promise<ListingWithDesign[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("listings")
    .select(
      `*,
       design_packages:design_packages!listings_design_package_id_fkey(
         id, image_url, mockup_urls, printify_blueprint_id, mockups_from_actual_design,
         trend_briefs:trend_briefs!design_packages_trend_brief_id_fkey(
           id, niche
         )
       )`,
    )
    .eq("status", status)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error || !data) {
    console.error("getListingsByStatus failed", error);
    return [];
  }
  return (data as RawListingJoin[]).map(flattenListing);
}

type RawListingJoin = ListingRow & {
  design_packages:
    | (Pick<DesignPackageRow, "id" | "image_url" | "mockup_urls" | "printify_blueprint_id" | "mockups_from_actual_design"> & {
        trend_briefs: Pick<TrendBriefRow, "id" | "niche"> | null;
      })
    | null;
};

function flattenListing(row: RawListingJoin): ListingWithDesign {
  const dp = row.design_packages;
  return {
    ...row,
    design_packages: dp
      ? {
          id: dp.id,
          image_url: dp.image_url,
          mockup_urls: dp.mockup_urls,
          printify_blueprint_id: dp.printify_blueprint_id,
          mockups_from_actual_design: dp.mockups_from_actual_design,
        }
      : null,
    trend_brief: dp?.trend_briefs ?? null,
  };
}

export async function getListing(id: string): Promise<ListingWithDesign | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("listings")
    .select(
      `*,
       design_packages:design_packages!listings_design_package_id_fkey(
         id, image_url, mockup_urls, printify_blueprint_id, mockups_from_actual_design,
         trend_briefs:trend_briefs!design_packages_trend_brief_id_fkey(
           id, niche
         )
       )`,
    )
    .eq("id", id)
    .maybeSingle();
  if (error || !data) {
    if (error) console.error("getListing failed", error);
    return null;
  }
  return flattenListing(data as RawListingJoin);
}

export async function getRecentListings(limit = 20): Promise<ListingWithDesign[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("listings")
    .select(
      `*,
       design_packages:design_packages!listings_design_package_id_fkey(
         id, image_url, mockup_urls, printify_blueprint_id, mockups_from_actual_design,
         trend_briefs:trend_briefs!design_packages_trend_brief_id_fkey(
           id, niche
         )
       )`,
    )
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error || !data) {
    console.error("getRecentListings failed", error);
    return [];
  }
  return (data as RawListingJoin[]).map(flattenListing);
}

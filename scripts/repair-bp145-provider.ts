#!/usr/bin/env node
/**
 * One-shot repair for blueprint-145 design_packages rows that still carry
 * printify_print_provider_id = 3 (the old Marco Fine Arts provider). The
 * correct provider for bp145 is 39 (SwiftPOD). Rows with provider = 3 were
 * written before GILDAN_64000_PRINT_PROVIDER_ID was updated in constants.py,
 * and they now fail Listing's assertBlueprintSupported check.
 *
 * VARIANT IDS DO NOT CHANGE. The five default IDs (White S/M/L/XL/2XL)
 *   38163, 38177, 38191, 38205, 38219
 * are valid for both provider 3 and provider 39 for blueprint 145.
 * The printify_variant_catalog has 419 rows for (blueprint=145, provider=39)
 * and zero rows for provider=3, so re-resolution always produces the same IDs.
 *
 * Only printify_print_provider_id is updated — no status or variant_ids touch.
 *
 * LISTING ROWS REPAIRED (two stuck listings):
 *   - 7003f63f: provider mismatch error → reset to pending (price already $25.99)
 *   - df6deef2: $0 price error → reset to pending, price set to $25.99
 *
 * Designs where active listings already exist are updated for data hygiene
 * (the live Etsy listing and Printify product are unaffected — this is purely
 * a metadata correction on the design_packages row).
 *
 * SAFETY: Before updating, the script queries printify_variant_catalog to
 * verify that the design's shirt_colors × shirt_sizes resolves to at least one
 * provider-39 row. If resolution yields nothing, the design is SKIPPED and
 * reported — this should not happen for the current data set (all 16 rows carry
 * White, which resolves cleanly to provider-39 IDs), but the check guards
 * against future edge cases.
 *
 * Default = DRY RUN (prints the plan, writes nothing). Pass --apply to commit.
 *
 * Usage:
 *   node --env-file=.env --import tsx/esm scripts/repair-bp145-provider.ts
 *   node --env-file=.env --import tsx/esm scripts/repair-bp145-provider.ts --apply
 *
 * Runs against cloud Supabase (creds from .env). No Etsy or Printify API calls
 * are made — this script only reads and writes Supabase.
 */

import { getDb } from "../packages/shared/src/db.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const BLUEPRINT_ID = 145;
const BAD_PROVIDER_ID = 3;      // Marco Fine Arts (old, incorrect)
const GOOD_PROVIDER_ID = 39;    // SwiftPOD (correct)

// Default Etsy listing price to apply when a stuck listing has price_usd = 0.
// Must clear the pricing floor: $10.09 (print cost) × 2.5 = $25.23.
const DEFAULT_PRICE_USD = 25.99;

// Stuck listing IDs that need status + price repairs in addition to the
// design_packages provider update. Source: repairAlgorithm in the task spec.
const LISTING_PROVIDER_ERROR_ID = "7003f63f-5267-4cd5-afb4-31fb4cee29b9"; // price already $25.99
const LISTING_ZERO_PRICE_ID = "df6deef2-d345-4301-bd20-d6826c89515a";     // price_usd = 0

// ── Types ─────────────────────────────────────────────────────────────────────

interface DesignRow {
  id: string;
  status: string;
  printify_print_provider_id: number | null;
  printify_variant_ids: number[] | null;
  trend_brief_id: string | null;
}

interface BriefRow {
  id: string;
  shirt_colors: string[] | null;
  shirt_sizes: string[] | null;
}

interface CatalogRow {
  variant_id: number;
}

interface DesignRepair {
  designId: string;
  designStatus: string;
  shirtColors: string[];
  shirtSizes: string[];
  currentVariantIds: number[];
  resolvedVariantIds: number[];  // same as current for this data set
  canRepair: boolean;
  skipReason?: string;
}

interface ListingRepair {
  listingId: string;
  reason: string;
  priceFix?: number;  // set if price_usd also needs updating
}

// ── Catalog resolution ────────────────────────────────────────────────────────

/** Resolve provider-39 variant IDs for the given colors × sizes from
 *  printify_variant_catalog. Returns an empty array when no rows match. */
async function resolveProvider39VariantIds(
  db: ReturnType<typeof getDb>,
  colors: string[],
  sizes: string[]
): Promise<number[]> {
  if (colors.length === 0 || sizes.length === 0) return [];

  const { data, error } = await db
    .from("printify_variant_catalog")
    .select("variant_id")
    .eq("blueprint_id", BLUEPRINT_ID)
    .eq("print_provider_id", GOOD_PROVIDER_ID)
    .in("color", colors)
    .in("size", sizes)
    .eq("is_available", true);

  if (error) throw new Error(`catalog query failed: ${error.message}`);

  const rows = (data ?? []) as CatalogRow[];
  return [...new Set(rows.map((r) => r.variant_id))].sort((a, b) => a - b);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const apply = process.argv.includes("--apply");
  const db = getDb();

  console.log(`\n── bp145 provider repair (${apply ? "APPLY" : "DRY RUN"}) ──\n`);

  // 1. Load all bp145 design_packages rows with the wrong provider.
  const { data: designData, error: designErr } = await db
    .from("design_packages")
    .select("id, status, printify_print_provider_id, printify_variant_ids, trend_brief_id")
    .eq("printify_blueprint_id", BLUEPRINT_ID)
    .eq("printify_print_provider_id", BAD_PROVIDER_ID);

  if (designErr) throw new Error(`Failed to load design_packages: ${designErr.message}`);
  const designs = (designData ?? []) as DesignRow[];

  if (designs.length === 0) {
    console.log("No bp145 designs with provider=3 found. Nothing to repair.\n");
    return;
  }

  console.log(`Found ${designs.length} design_packages row(s) with provider=${BAD_PROVIDER_ID}.\n`);

  // 2. Load the associated trend_briefs for shirt_colors / shirt_sizes.
  const briefIds = [
    ...new Set(designs.map((d) => d.trend_brief_id).filter((id): id is string => id != null)),
  ];

  const { data: briefData, error: briefErr } = await db
    .from("trend_briefs")
    .select("id, shirt_colors, shirt_sizes")
    .in("id", briefIds);

  if (briefErr) throw new Error(`Failed to load trend_briefs: ${briefErr.message}`);
  const briefMap = new Map<string, BriefRow>(
    ((briefData ?? []) as BriefRow[]).map((b) => [b.id, b])
  );

  // 3. For each design, verify the catalog resolves cleanly to provider-39 IDs.
  const repairs: DesignRepair[] = [];

  for (const d of designs) {
    const brief = d.trend_brief_id != null ? briefMap.get(d.trend_brief_id) : undefined;
    // Fall back to the canonical White S/M/L/XL/2XL defaults if the brief is
    // missing or has empty color/size arrays (matches the Python fallback in
    // resolve_variant_ids and the DB column defaults from migration 054).
    const shirtColors = brief?.shirt_colors?.length ? brief.shirt_colors : ["White"];
    const shirtSizes =
      brief?.shirt_sizes?.length ? brief.shirt_sizes : ["S", "M", "L", "XL", "2XL"];

    const currentVariantIds = (d.printify_variant_ids ?? []).slice().sort((a, b) => a - b);
    const resolvedVariantIds = await resolveProvider39VariantIds(db, shirtColors, shirtSizes);

    if (resolvedVariantIds.length === 0) {
      repairs.push({
        designId: d.id,
        designStatus: d.status,
        shirtColors,
        shirtSizes,
        currentVariantIds,
        resolvedVariantIds: [],
        canRepair: false,
        skipReason: `colors=${JSON.stringify(shirtColors)} × sizes=${JSON.stringify(shirtSizes)} resolves to 0 provider-39 catalog rows — operator review required`,
      });
    } else {
      repairs.push({
        designId: d.id,
        designStatus: d.status,
        shirtColors,
        shirtSizes,
        currentVariantIds,
        resolvedVariantIds,
        canRepair: true,
      });
    }
  }

  // 4. Determine which stuck listings need repair.
  const listingRepairs: ListingRepair[] = [
    {
      listingId: LISTING_PROVIDER_ERROR_ID,
      reason: "provider mismatch error (price_usd already $25.99 — reset to pending only)",
    },
    {
      listingId: LISTING_ZERO_PRICE_ID,
      reason: "$0 price error — reset to pending and set price_usd to $25.99",
      priceFix: DEFAULT_PRICE_USD,
    },
  ];

  // Verify the two listing IDs exist before reporting.
  const { data: listingData } = await db
    .from("listings")
    .select("id, status, price_usd, error_message")
    .in("id", listingRepairs.map((l) => l.listingId));

  const listingMap = new Map<string, { id: string; status: string; price_usd: number | null; error_message: string | null }>(
    ((listingData ?? []) as Array<{ id: string; status: string; price_usd: number | null; error_message: string | null }>)
      .map((r) => [r.id, r])
  );

  // ── Report ────────────────────────────────────────────────────────────────────

  const repairable = repairs.filter((r) => r.canRepair);
  const skipped = repairs.filter((r) => !r.canRepair);

  console.log(`Design repairs (provider ${BAD_PROVIDER_ID} → ${GOOD_PROVIDER_ID}):`);
  console.log(`  repairable: ${repairable.length}`);
  console.log(`  skipped (unresolvable color/size): ${skipped.length}\n`);

  for (const r of repairable) {
    const variantChanged =
      JSON.stringify(r.currentVariantIds) !== JSON.stringify(r.resolvedVariantIds);
    console.log(`  • ${r.designId}  status=${r.designStatus}`);
    console.log(`      colors=${JSON.stringify(r.shirtColors)}  sizes=${JSON.stringify(r.shirtSizes)}`);
    console.log(`      provider: ${BAD_PROVIDER_ID} → ${GOOD_PROVIDER_ID}`);
    if (variantChanged) {
      console.log(`      variant_ids: ${JSON.stringify(r.currentVariantIds)} → ${JSON.stringify(r.resolvedVariantIds)}`);
    } else {
      console.log(`      variant_ids: unchanged (${JSON.stringify(r.currentVariantIds)})`);
    }
  }

  if (skipped.length > 0) {
    console.log(`\nSKIPPED (operator review required):`);
    for (const r of skipped) {
      console.log(`  • ${r.designId}  status=${r.designStatus}`);
      console.log(`      reason: ${r.skipReason}`);
    }
  }

  console.log(`\nListing repairs:`);
  for (const lr of listingRepairs) {
    const row = listingMap.get(lr.listingId);
    if (!row) {
      console.log(`  • ${lr.listingId}  NOT FOUND in DB — skipping`);
      continue;
    }
    console.log(`  • ${lr.listingId}  (current status=${row.status}, price_usd=${row.price_usd})`);
    console.log(`      reason: ${lr.reason}`);
    console.log(`      → status: pending, error_message: null, retry_count: 0${lr.priceFix != null ? `, price_usd: ${lr.priceFix}` : ""}`);
  }

  if (!apply) {
    console.log(
      `\nDry run — no changes written. Re-run with --apply to commit.\n`
    );
    return;
  }

  // ── Apply ─────────────────────────────────────────────────────────────────────

  let designRepairCount = 0;
  for (const r of repairable) {
    const update: Record<string, unknown> = {
      printify_print_provider_id: GOOD_PROVIDER_ID,
    };
    // Update variant_ids only if they actually changed (they should NOT for this
    // data set, but apply defensively if they somehow diverge).
    if (JSON.stringify(r.currentVariantIds) !== JSON.stringify(r.resolvedVariantIds)) {
      update.printify_variant_ids = r.resolvedVariantIds;
    }

    const { error } = await db
      .from("design_packages")
      .update(update)
      .eq("id", r.designId);

    if (error) {
      console.error(`  ERROR: design ${r.designId}: ${error.message}`);
    } else {
      console.log(`  repaired design ${r.designId} (status=${r.designStatus})`);
      designRepairCount++;
    }
  }

  let listingRepairCount = 0;
  for (const lr of listingRepairs) {
    const row = listingMap.get(lr.listingId);
    if (!row) {
      console.log(`  SKIP listing ${lr.listingId}: not found`);
      continue;
    }

    const update: Record<string, unknown> = {
      status: "pending",
      error_message: null,
      retry_count: 0,
    };
    if (lr.priceFix != null) {
      update.price_usd = lr.priceFix;
    }

    const { error } = await db
      .from("listings")
      .update(update)
      .eq("id", lr.listingId);

    if (error) {
      console.error(`  ERROR: listing ${lr.listingId}: ${error.message}`);
    } else {
      console.log(`  repaired listing ${lr.listingId}${lr.priceFix != null ? ` (price_usd set to ${lr.priceFix})` : ""}`);
      listingRepairCount++;
    }
  }

  console.log(
    `\nApplied: ${designRepairCount}/${repairable.length} designs, ${listingRepairCount}/${listingRepairs.length} listings.\n`
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

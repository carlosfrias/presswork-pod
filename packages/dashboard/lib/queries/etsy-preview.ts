import "server-only";
import {
  buildInventoryFromDesign,
  blueprintMaterials,
  blueprintProcessingDays,
  type EtsyInventoryInput,
} from "@presswork/shared";
import { serviceClient } from "@/lib/supabase/server";

/**
 * Snapshot of the exact payloads the listing publisher would POST/PUT to
 * Etsy when the operator approves this listing. Pure read — no mutations,
 * no Etsy calls. Builds against the same shared helpers the publisher uses
 * (buildInventoryFromDesign, blueprint constants) so the preview cannot drift
 * from real publish behavior.
 */
export interface EtsyPayloadPreview {
  ok: boolean;
  /** True when ETSY_MOCK_MODE is on. Surfaced to the UI as a banner. */
  mockMode: boolean;
  /** Reason this preview can't be assembled (only set when ok=false). */
  reason?: string;
  /**
   * Body of POST /v3/application/shops/{ETSY_SHOP_ID}/listings.
   * Excludes taxonomy_id when the cache hasn't been warmed (publisher will
   * resolve it on first call).
   */
  createListing?: Record<string, unknown>;
  /** Body of PUT /v3/application/listings/{listing_id}/inventory. */
  inventory?: EtsyInventoryInput;
  /** One entry per mockup URL — what uploadListingImage will send. */
  images?: Array<{ url: string; rank: number; altText: string }>;
  /**
   * Body of PATCH /v3/application/shops/{ETSY_SHOP_ID}/listings/{listing_id}
   * — the activation step. Always { state: "active" }.
   */
  activate?: { state: "active" };
}

interface PreviewRow {
  id: string;
  status: string;
  title: string | null;
  description: string | null;
  tags: string[] | null;
  price_usd: number | null;
  design_packages:
    | {
        id: string;
        mockup_urls: string[] | null;
        mockups_from_actual_design: boolean | null;
        printify_blueprint_id: number | null;
        printify_variants: Array<{ id: number; values: string[] }> | null;
      }
    | null;
}

export async function getEtsyPayloadPreview(
  listingId: string
): Promise<EtsyPayloadPreview> {
  const mockMode = process.env.ETSY_MOCK_MODE === "true";
  const db = serviceClient();

  const { data, error } = await db
    .from("listings")
    .select(
      `id, status, title, description, tags, price_usd,
       design_packages:design_packages!listings_design_package_id_fkey(
         id, mockup_urls, mockups_from_actual_design,
         printify_blueprint_id, printify_variants
       )`
    )
    .eq("id", listingId)
    .maybeSingle();

  if (error || !data) {
    return {
      ok: false,
      mockMode,
      reason: error?.message ?? "listing not found",
    };
  }

  const row = data as unknown as PreviewRow;

  if (!row.title || !row.description || !row.tags || row.price_usd == null) {
    return {
      ok: false,
      mockMode,
      reason:
        "listing is missing copy or price — preview is only available once Claude has written copy and the row is in needs_review",
    };
  }

  const dp = row.design_packages;
  if (!dp) {
    return {
      ok: false,
      mockMode,
      reason: "listing has no joined design_package",
    };
  }
  if (!dp.printify_blueprint_id) {
    return {
      ok: false,
      mockMode,
      reason: "design_package missing printify_blueprint_id",
    };
  }
  if (!dp.printify_variants || dp.printify_variants.length === 0) {
    return {
      ok: false,
      mockMode,
      reason:
        "design_package has no printify_variants — Printify product creation must run first",
    };
  }

  const mockupUrls = dp.mockup_urls ?? [];

  // Read the cached taxonomy_id directly from config rather than calling
  // getTaxonomyId() (which would hit Etsy on cache miss). The preview
  // should never trigger network calls. Empty cache → omit the field with
  // a note in `_unresolved` so the operator sees what's missing.
  const { data: taxonomyRow } = await db
    .from("config")
    .select("value")
    .eq("key", "etsy_taxonomy_tshirt")
    .maybeSingle();
  const taxonomyId =
    taxonomyRow && typeof (taxonomyRow as { value?: string }).value === "string"
      ? Number((taxonomyRow as { value: string }).value)
      : null;

  const shippingProfileId = process.env.ETSY_SHIPPING_PROFILE_ID
    ? Number(process.env.ETSY_SHIPPING_PROFILE_ID)
    : null;
  const productionPartnerId = process.env.ETSY_PRODUCTION_PARTNER_ID
    ? Number(process.env.ETSY_PRODUCTION_PARTNER_ID)
    : null;
  const readinessStateId = process.env.ETSY_READINESS_STATE_ID
    ? Number(process.env.ETSY_READINESS_STATE_ID)
    : null;

  const materials = blueprintMaterials(dp.printify_blueprint_id);
  const processing = blueprintProcessingDays(dp.printify_blueprint_id);

  const createListing: Record<string, unknown> = {
    taxonomy_id: taxonomyId,
    who_made: "i_did",
    when_made: "made_to_order",
    is_supply: false,
    shipping_profile_id: shippingProfileId,
    readiness_state_id: readinessStateId,
    production_partner_ids: productionPartnerId ? [productionPartnerId] : [],
    title: row.title,
    description: row.description,
    price: row.price_usd,
    tags: row.tags,
    ...(materials ? { materials } : {}),
    ...(processing
      ? { processing_min: processing.min, processing_max: processing.max }
      : {}),
  };

  let inventory: EtsyInventoryInput | undefined;
  try {
    inventory = buildInventoryFromDesign({
      design: {
        printify_blueprint_id: dp.printify_blueprint_id,
        printify_variants: dp.printify_variants,
      },
      priceUsd: row.price_usd,
      readinessStateId,
    });
  } catch (err) {
    return {
      ok: false,
      mockMode,
      reason: `inventory build failed: ${(err as Error).message}`,
    };
  }

  const images = mockupUrls.map((url, i) => ({
    url,
    rank: i + 1,
    altText:
      mockupUrls.length === 1
        ? `Product photo of: ${row.title}`
        : `Product photo ${i + 1} of: ${row.title}`,
  }));

  return {
    ok: true,
    mockMode,
    createListing,
    inventory,
    images,
    activate: { state: "active" },
  };
}

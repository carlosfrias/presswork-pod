import {
  type Db,
  type DesignPackage,
  type ListingCopy,
  type TrendBrief,
  createDraftListing,
  uploadListingImage,
  activateListing,
  getLogger,
  getSettings,
} from "@presswork/shared";
import { writeCopy } from "./copywriter.js";
import { validatePricingFloor } from "./pricing.js";
import { createHiddenProduct, setProductVisible } from "./printify.js";
import {
  validateCopyCompliance,
  validateMockupProvenance,
  validateProductionPartnerId,
} from "./compliance.js";
import { GILDAN_64000_PRINT_COST_USD, ETSY_TAXONOMY_ID_TSHIRT } from "./constants.js";

export class PublisherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublisherError";
  }
}

export async function publishOne(
  db: Db,
  design: DesignPackage,
  brief: TrendBrief
): Promise<{ listingId: string }> {
  const log = getLogger("listing");
  const { HUMAN_REVIEW_ENABLED, ETSY_PRODUCTION_PARTNER_ID } = getSettings();
  const t0 = Date.now();

  // Step 1: pricing floor check
  const priceUsd = brief.price_target_usd ?? 0;
  validatePricingFloor(priceUsd, GILDAN_64000_PRINT_COST_USD);

  // Step 1b: Etsy compliance pre-checks that don't need any external calls.
  // Production partner ID must be configured before we even spend a Claude token.
  validateProductionPartnerId(ETSY_PRODUCTION_PARTNER_ID);

  // Step 2: generate copy via Claude
  log.info({ action: "generate_copy", record_id: design.id, status: "started" });
  const copy = await writeCopy(brief, design);

  // Step 2b: Hard gate copy against Etsy seller-policy rules. ListingCopySchema
  // already enforces the AI disclosure on the Claude response shape; this catches
  // anything that slipped past (e.g. forbidden terms in title/tags, off-platform
  // language) before we touch Printify or Etsy.
  validateCopyCompliance(copy);

  // Step 3: insert listings row at 'pending'
  const { data: listingRow, error: insertErr } = await db
    .from("listings")
    .insert({
      design_package_id: design.id,
      status: "pending",
      title: copy.title,
      description: copy.description,
      tags: copy.tags,
      price_usd: priceUsd,
    })
    .select("id")
    .single();

  if (insertErr || !listingRow) {
    throw new PublisherError(`Failed to insert listings row: ${insertErr?.message}`);
  }
  const listingId = (listingRow as { id: string }).id;

  try {
    // Step 4: create hidden Printify product (mockups are a side effect)
    log.info({ action: "create_printify_product", record_id: listingId, status: "started" });
    const { productId, mockupUrls } = await createHiddenProduct({
      imageUrl: design.image_url ?? "",
      blueprintId: design.printify_blueprint_id ?? 5,
      variantIds: design.printify_variant_ids ?? [],
      title: copy.title,
    });

    // Step 5: write mockup URLs back to the design_package and persist productId on the listing.
    // mockups_from_actual_design is set true here because Printify generated these mockups by
    // compositing this design's image_url onto blueprint variants — they are by construction
    // images of the actual design, satisfying the Etsy image-policy gate enforced below.
    await db
      .from("design_packages")
      .update({ mockup_urls: mockupUrls, mockups_from_actual_design: true })
      .eq("id", design.id);

    await db
      .from("listings")
      .update({ printify_product_id: productId })
      .eq("id", listingId);

    // Step 6: human review gate
    if (HUMAN_REVIEW_ENABLED) {
      await db.from("listings").update({ status: "needs_review" }).eq("id", listingId);
      log.info({
        action: "paused_for_review",
        record_id: listingId,
        status: "needs_review",
        duration_ms: Date.now() - t0,
      });
      return { listingId };
    }

    await db.from("listings").update({ status: "pending_publish" }).eq("id", listingId);

    // Steps 7–12: Etsy publish flow. We pass mockupsFromActualDesign=true because we
    // just set it true above; resumePublish reads the current DB value instead.
    await executeEtsyPublish(db, listingId, productId, copy, priceUsd, mockupUrls, true);

    log.info({
      action: "listing_published",
      record_id: listingId,
      status: "active",
      duration_ms: Date.now() - t0,
    });

    return { listingId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const { data: current } = await db
      .from("listings")
      .select("retry_count")
      .eq("id", listingId)
      .single();
    const retryCount = ((current as { retry_count?: number } | null)?.retry_count ?? 0) + 1;

    if (retryCount < 3) {
      await db
        .from("listings")
        .update({ status: "pending", error_message: message, retry_count: retryCount })
        .eq("id", listingId);
    } else {
      await db
        .from("listings")
        .update({ status: "error", error_message: message, retry_count: retryCount })
        .eq("id", listingId);
    }

    log.error({
      action: "publish_failed",
      record_id: listingId,
      status: "error",
      duration_ms: Date.now() - t0,
      error: message,
    });

    throw err;
  }
}

async function executeEtsyPublish(
  db: Db,
  listingId: string,
  productId: string,
  copy: ListingCopy,
  priceUsd: number,
  mockupUrls: string[],
  mockupsFromActualDesign: boolean
): Promise<void> {
  const { ETSY_SHIPPING_PROFILE_ID, ETSY_PRODUCTION_PARTNER_ID } = getSettings();

  // Last-line compliance gates immediately before talking to Etsy. These guard
  // against any state where the DB row drifted (e.g. resumePublish picking up
  // stale data) or a config change between the queue insert and the publish.
  validateProductionPartnerId(ETSY_PRODUCTION_PARTNER_ID);
  validateMockupProvenance(mockupsFromActualDesign);
  validateCopyCompliance(copy);

  const { listing_id: etsyListingId } = await createDraftListing(db, {
    taxonomy_id: ETSY_TAXONOMY_ID_TSHIRT,
    who_made: "i_did",
    when_made: "made_to_order",
    is_supply: false,
    shipping_profile_id: ETSY_SHIPPING_PROFILE_ID,
    production_partner_ids: [ETSY_PRODUCTION_PARTNER_ID],
    title: copy.title,
    description: copy.description,
    price: priceUsd,
    tags: copy.tags,
  });

  for (const url of mockupUrls) {
    await uploadListingImage(db, etsyListingId, url);
  }

  await activateListing(db, etsyListingId);
  await setProductVisible(productId);

  await db
    .from("listings")
    .update({ status: "active", is_active: true, etsy_listing_id: etsyListingId })
    .eq("id", listingId);
}

export async function resumePublish(db: Db, listingId: string): Promise<void> {
  const log = getLogger("listing");
  const t0 = Date.now();

  const { data: row, error: rowErr } = await db
    .from("listings")
    .select("status, printify_product_id, title, description, tags, price_usd, retry_count")
    .eq("id", listingId)
    .single();

  if (rowErr || !row) {
    throw new PublisherError(`Listing ${listingId} not found`);
  }

  const listing = row as {
    status: string;
    printify_product_id: string | null;
    title: string | null;
    description: string | null;
    tags: string[] | null;
    price_usd: number | null;
    retry_count: number;
  };

  if (listing.status !== "pending_publish") {
    throw new PublisherError(
      `resumePublish requires status='pending_publish', got '${listing.status}'`
    );
  }

  if (!listing.printify_product_id) {
    throw new PublisherError(`Listing ${listingId} has no printify_product_id`);
  }

  // Fetch mockup_urls + provenance flag from the joined design_packages row.
  // The provenance flag must travel with the mockups so the downstream Etsy
  // publish can re-verify image-policy compliance even on a resumed/retried run.
  const { data: designRow } = await db
    .from("listings")
    .select("design_packages(mockup_urls,mockups_from_actual_design)")
    .eq("id", listingId)
    .single();

  const designJoin =
    (
      designRow as {
        design_packages?: {
          mockup_urls?: string[] | null;
          mockups_from_actual_design?: boolean | null;
        } | null;
      } | null
    )?.design_packages ?? null;

  const mockupUrls: string[] = designJoin?.mockup_urls ?? [];
  const mockupsFromActualDesign: boolean = designJoin?.mockups_from_actual_design ?? false;

  const copy: ListingCopy = {
    title: listing.title ?? "",
    description: listing.description ?? "",
    tags: listing.tags ?? [],
  };

  try {
    await executeEtsyPublish(
      db,
      listingId,
      listing.printify_product_id,
      copy,
      listing.price_usd ?? 0,
      mockupUrls,
      mockupsFromActualDesign
    );
    log.info({
      action: "resume_publish_complete",
      record_id: listingId,
      status: "active",
      duration_ms: Date.now() - t0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const retryCount = listing.retry_count + 1;

    if (retryCount < 3) {
      await db
        .from("listings")
        .update({ status: "pending_publish", error_message: message, retry_count: retryCount })
        .eq("id", listingId);
    } else {
      await db
        .from("listings")
        .update({ status: "error", error_message: message, retry_count: retryCount })
        .eq("id", listingId);
    }

    log.error({
      action: "resume_publish_failed",
      record_id: listingId,
      status: "error",
      duration_ms: Date.now() - t0,
      error: message,
    });

    throw err;
  }
}

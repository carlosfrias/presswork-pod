import {
  type Db,
  type DesignPackage,
  type ListingCopy,
  type TrendBrief,
  createDraftListing,
  uploadListingImage,
  activateListing,
  getTaxonomyId,
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
import { GILDAN_64000_PRINT_COST_USD } from "./constants.js";

const MAX_RETRIES = 3;

export class PublisherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublisherError";
  }
}

type ExistingListingRow = {
  id: string;
  status: string;
  title: string | null;
  description: string | null;
  tags: string[] | null;
  price_usd: number | null;
  printify_product_id: string | null;
  is_active: boolean | null;
  retry_count: number | null;
};

export async function publishOne(
  db: Db,
  design: DesignPackage,
  brief: TrendBrief
): Promise<{ listingId: string }> {
  const log = getLogger("listing");
  const { HUMAN_REVIEW_ENABLED, ETSY_PRODUCTION_PARTNER_ID } = getSettings();
  const t0 = Date.now();

  // Pre-flight checks that don't depend on any DB state.
  const priceUsd = brief.price_target_usd ?? 0;
  validatePricingFloor(priceUsd, GILDAN_64000_PRINT_COST_USD);
  validateProductionPartnerId(ETSY_PRODUCTION_PARTNER_ID);

  // Checkpoint resume: a prior attempt may have created a listings row and even a
  // Printify product. Reuse those instead of paying Claude again or orphaning the
  // Printify product. We only resume from non-terminal states; an `active` or
  // `error` row is treated as foreign and aborts (operator intervention required).
  const existing = await loadExistingListing(db, design.id);

  if (existing?.is_active) {
    throw new PublisherError(
      `design_package ${design.id} already has an active listing ${existing.id}`
    );
  }

  const canResumeCopy = Boolean(
    existing && existing.title && existing.description && existing.tags && existing.tags.length > 0
  );

  let listingId: string;
  let copy: ListingCopy;

  if (existing && canResumeCopy) {
    listingId = existing.id;
    copy = {
      title: existing.title as string,
      description: existing.description as string,
      tags: existing.tags as string[],
    };
    validateCopyCompliance(copy);
    log.info({
      action: "resume_existing_listing",
      record_id: listingId,
      status: existing.status,
    });
  } else {
    log.info({ action: "generate_copy", record_id: design.id, status: "started" });
    copy = await writeCopy(brief, design);
    validateCopyCompliance(copy);

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
    listingId = (listingRow as { id: string }).id;
  }

  try {
    let productId: string;
    let mockupUrls: string[];

    if (existing?.printify_product_id) {
      productId = existing.printify_product_id;
      mockupUrls = design.mockup_urls ?? [];
      log.info({
        action: "resume_skip_printify_create",
        record_id: listingId,
        printify_product_id: productId,
      });
    } else {
      if (!design.printify_print_provider_id) {
        throw new PublisherError(
          `design_packages.printify_print_provider_id is required (design ${design.id})`
        );
      }
      log.info({ action: "create_printify_product", record_id: listingId, status: "started" });
      const result = await createHiddenProduct({
        imageUrl: design.image_url ?? "",
        blueprintId: design.printify_blueprint_id ?? 5,
        printProviderId: design.printify_print_provider_id,
        variantIds: design.printify_variant_ids ?? [],
        title: copy.title,
      });
      productId = result.productId;
      mockupUrls = result.mockupUrls;

      // mockups_from_actual_design is set true here because Printify generated these
      // mockups by compositing this design's image_url onto blueprint variants — they
      // are by construction images of the actual design (compliance rule 4).
      // printify_variants captures the per-variant option labels (size/color) so
      // Fulfillment can match an Etsy receipt's transaction.variations back to
      // the correct variant_id instead of always using printify_variant_ids[0].
      await db
        .from("design_packages")
        .update({
          mockup_urls: mockupUrls,
          mockups_from_actual_design: true,
          printify_variants: result.variants,
        })
        .eq("id", design.id);

      await db
        .from("listings")
        .update({ printify_product_id: productId })
        .eq("id", listingId);
    }

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

    // The documented state machine requires a 'publishing' checkpoint between
    // pending_publish and active so an interrupted publish is observable.
    await db.from("listings").update({ status: "publishing" }).eq("id", listingId);

    await executeEtsyPublish(db, listingId, productId, copy, priceUsd, mockupUrls, true);

    log.info({
      action: "listing_published",
      record_id: listingId,
      status: "active",
      duration_ms: Date.now() - t0,
    });

    return { listingId };
  } catch (err) {
    let message = err instanceof Error ? err.message : String(err);
    const { data: current, error: readErr } = await db
      .from("listings")
      .select("retry_count")
      .eq("id", listingId)
      .single();

    // If we cannot read retry_count, force terminal — silently allowing
    // infinite retries is worse than terminating one listing prematurely.
    let retryCount: number;
    if (readErr) {
      log.error({
        action: "retry_count_read_failed",
        record_id: listingId,
        error: readErr.message,
      });
      message = `${message} (retry_count read failed: ${readErr.message}; forcing terminal)`;
      retryCount = MAX_RETRIES;
    } else {
      retryCount = ((current as { retry_count?: number } | null)?.retry_count ?? 0) + 1;
    }

    if (retryCount < MAX_RETRIES) {
      await db
        .from("listings")
        .update({ status: "pending", error_message: message, retry_count: retryCount })
        .eq("id", listingId);
      // Reset the parent design_packages back to 'done' so the poller re-claims it
      // for the retry. Without this the row strands in 'processing' forever.
      await db
        .from("design_packages")
        .update({ status: "done", error_message: message })
        .eq("id", design.id);
    } else {
      await db
        .from("listings")
        .update({ status: "error", error_message: message, retry_count: retryCount })
        .eq("id", listingId);
      await db
        .from("design_packages")
        .update({ status: "error", error_message: message })
        .eq("id", design.id);
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

async function loadExistingListing(db: Db, designPackageId: string): Promise<ExistingListingRow | null> {
  const { data } = await db
    .from("listings")
    .select(
      "id, status, title, description, tags, price_usd, printify_product_id, is_active, retry_count"
    )
    .eq("design_package_id", designPackageId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return (data as ExistingListingRow | null) ?? null;
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
  const { ETSY_SHIPPING_PROFILE_ID, ETSY_PRODUCTION_PARTNER_ID, ETSY_READINESS_STATE_ID } = getSettings();

  // Last-line compliance gates immediately before talking to Etsy. These guard
  // against any state where the DB row drifted (e.g. resumePublish picking up
  // stale data) or a config change between the queue insert and the publish.
  validateProductionPartnerId(ETSY_PRODUCTION_PARTNER_ID);
  validateMockupProvenance(mockupsFromActualDesign);
  validateCopyCompliance(copy);

  // Resume guard: if a prior attempt created an Etsy draft, reuse it. Persisting
  // etsy_listing_id immediately after createDraftListing (below) means any later
  // failure leaves the id behind so we don't POST a second draft on retry.
  const { data: priorRow } = await db
    .from("listings")
    .select("etsy_listing_id")
    .eq("id", listingId)
    .single();
  let etsyListingId =
    (priorRow as { etsy_listing_id: number | null } | null)?.etsy_listing_id ?? null;

  if (etsyListingId === null) {
    const taxonomyId = await getTaxonomyId(db, "tshirt");
    const { listing_id } = await createDraftListing(db, {
      taxonomy_id: taxonomyId,
      who_made: "i_did",
      when_made: "made_to_order",
      is_supply: false,
      shipping_profile_id: ETSY_SHIPPING_PROFILE_ID,
      readiness_state_id: ETSY_READINESS_STATE_ID,
      production_partner_ids: [ETSY_PRODUCTION_PARTNER_ID],
      title: copy.title,
      description: copy.description,
      price: priceUsd,
      tags: copy.tags,
    });
    etsyListingId = listing_id;
    // Persist immediately, BEFORE attempting image upload or activation, so any
    // failure between here and the final 'active' write doesn't strand the draft.
    await db
      .from("listings")
      .update({ etsy_listing_id: etsyListingId })
      .eq("id", listingId);
  }

  for (const url of mockupUrls) {
    await uploadListingImage(db, etsyListingId, url);
  }

  await activateListing(db, etsyListingId);
  await setProductVisible(productId);

  await db
    .from("listings")
    .update({ status: "active", is_active: true })
    .eq("id", listingId);
}

export async function resumePublish(db: Db, listingId: string): Promise<void> {
  const log = getLogger("listing");
  const t0 = Date.now();

  const { data: row, error: rowErr } = await db
    .from("listings")
    .select(
      "status, printify_product_id, title, description, tags, price_usd, retry_count, design_package_id"
    )
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
    design_package_id: string | null;
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
    // Same checkpoint as publishOne: mark 'publishing' before talking to Etsy.
    await db.from("listings").update({ status: "publishing" }).eq("id", listingId);

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

    if (retryCount < MAX_RETRIES) {
      await db
        .from("listings")
        .update({ status: "pending_publish", error_message: message, retry_count: retryCount })
        .eq("id", listingId);
    } else {
      await db
        .from("listings")
        .update({ status: "error", error_message: message, retry_count: retryCount })
        .eq("id", listingId);
      if (listing.design_package_id) {
        await db
          .from("design_packages")
          .update({ status: "error", error_message: message })
          .eq("id", listing.design_package_id);
      }
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

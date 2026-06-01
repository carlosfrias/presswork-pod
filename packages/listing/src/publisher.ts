import {
  type Db,
  type DesignPackage,
  type ListingCopy,
  type TrendBrief,
  createDraftListing,
  uploadListingImage,
  getListingImageCount,
  updateListingInventory,
  activateListing,
  getTaxonomyId,
  getLogger,
  getSettings,
  notifySlack,
  sanitizeListingCopy,
  POD_VARIANT_QUANTITY,
  validateVariantIds,
} from "@presswork/shared";
import { writeCopy } from "./copywriter.js";
import { validatePricingFloor } from "./pricing.js";
import {
  createHiddenProduct,
  setProductVisible,
  type PrintifyVariantOptions,
} from "./printify.js";
import {
  validateCopyCompliance,
  validateMockupProvenance,
  validateProductionPartnerId,
} from "./compliance.js";
import {
  GILDAN_64000_PRINT_COST_USD,
  assertBlueprintSupported,
  blueprintMaterials,
  blueprintProcessingDays,
  blueprintItemSpecs,
  defaultEtsyPriceUsd,
} from "./constants.js";
import { buildInventoryFromDesign } from "./inventory.js";

const MAX_RETRIES = 3;
// Etsy caps a listing at 10 images; attempting to upload more is a hard error.
const MAX_ETSY_LISTING_IMAGES = 10;

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
  brief: TrendBrief,
  listingId: string
): Promise<{ listingId: string }> {
  const log = getLogger("listing");
  const t0 = Date.now();

  // ── Pipeline contract ──────────────────────────────────────────────────────
  //
  // Listing NEVER writes to design_packages.status / .error_message — those
  // columns belong exclusively to the Design agent and the operator. Data
  // flows downstream (Design → Listing), never upstream. Consequences:
  //
  //   • The listings row is the unit of work. It's created atomically with
  //     the claim by the new claim_pending_design_package RPC (migration 046)
  //     so there's always a row to record progress / errors against.
  //
  //   • design.status stays at 'approved' for the design's whole lifetime in
  //     the listing pipeline. The listings page is where the operator sees
  //     publish state (needs_review / publishing / active / error).
  //
  //   • Mockup URLs / variant labels / mockups_from_actual_design ARE written
  //     to design_packages because they're DATA describing the design's
  //     deliverable (Printify-generated mockups of this design). Status and
  //     error_message remain off-limits.
  //
  // mockups_from_actual_design = true is set when Printify generates mockups
  // by compositing this design's image_url onto blueprint variants (Etsy
  // compliance rule 4 — listing images must come from the actual design).

  try {
    // Step 1: Load the current state of the listings row. The claim already
    // inserted it; on retries (status=pending after a transient failure or
    // operator click) it may already carry copy and/or a Printify product id.
    const existing = await loadListingState(db, listingId);
    if (!existing) {
      throw new PublisherError(`Listing ${listingId} not found`);
    }
    if (existing.is_active) {
      throw new PublisherError(
        `Listing ${listingId} is already active — refusing to re-publish`
      );
    }

    // Step 2: Pre-flight checks. Failures land on the listings row.
    //
    // Pricing source-of-truth: once a listings row exists (claim RPC seeds
    // it from brief.price_target_usd), the listings row owns the price. This
    // lets the operator edit listings.price_usd via the dashboard CopyEditor
    // and have that override stick on retry, without having to mutate the
    // upstream brief. Falls back to brief.price_target_usd when the listings
    // row's price_usd hasn't been set (legacy rows from before migration 046),
    // and further falls back to the per-blueprint default when neither source
    // carries a price (e.g. brief.price_target_usd = NULL and the claim RPC
    // seeded 0 via COALESCE(tb.price_target_usd, 0)).
    const priceUsd =
      existing.price_usd && existing.price_usd > 0
        ? existing.price_usd
        : (brief.price_target_usd ?? 0) > 0
          ? brief.price_target_usd!
          : defaultEtsyPriceUsd(design.printify_blueprint_id ?? 145);
    validatePricingFloor(priceUsd, GILDAN_64000_PRINT_COST_USD);
    const { ETSY_PRODUCTION_PARTNER_ID } = getSettings();
    validateProductionPartnerId(ETSY_PRODUCTION_PARTNER_ID);

    // Step 3: Copy generation. Skip if the listings row already carries copy
    // from a prior attempt — saves a Claude call on the resume path.
    const canResumeCopy = Boolean(
      existing.title && existing.description && existing.tags && existing.tags.length > 0
    );
    let copy: ListingCopy;
    if (canResumeCopy) {
      // Re-sanitize stored copy on the resume path so a row written before
      // em-dash stripping landed gets cleaned rather than blocked at publish.
      const stored = {
        title: existing.title as string,
        description: existing.description as string,
        tags: existing.tags as string[],
      };
      copy = sanitizeListingCopy(stored);
      validateCopyCompliance(copy);
      if (copy.title !== stored.title || copy.description !== stored.description) {
        await db
          .from("listings")
          .update({ title: copy.title, description: copy.description, tags: copy.tags })
          .eq("id", listingId);
        log.info({ action: "sanitized_existing_copy", record_id: listingId, status: existing.status });
      } else {
        log.info({ action: "resume_existing_copy", record_id: listingId, status: existing.status });
      }
    } else {
      // No model selection: copy is always written by the latest flagship Claude
      // (COPYWRITER_MODEL in copywriter.ts). writeCopy strips em dashes itself.
      log.info({ action: "generate_copy", record_id: listingId, status: "started" });
      copy = await writeCopy(brief, design);
      validateCopyCompliance(copy);
      await db
        .from("listings")
        .update({
          title: copy.title,
          description: copy.description,
          tags: copy.tags,
          price_usd: priceUsd,
        })
        .eq("id", listingId);
    }

    // Step 4: Printify product creation. Skip if the listings row already
    // carries a printify_product_id — only re-runs from "Recreate Printify
    // product" (which clears the id) trigger a fresh create.
    let productId: string;
    if (existing.printify_product_id) {
      productId = existing.printify_product_id;
      log.info({
        action: "resume_skip_printify_create",
        record_id: listingId,
        printify_product_id: productId,
      });
    } else {
      if (!design.printify_blueprint_id || !design.printify_print_provider_id) {
        throw new PublisherError(
          `design ${design.id} missing printify_blueprint_id or printify_print_provider_id`
        );
      }
      assertBlueprintSupported(
        design.printify_blueprint_id,
        design.printify_print_provider_id
      );

      // Load the operator's variant override. recreatePrintifyProduct on the
      // dashboard resets status→'pending' (not variants), so honoring the
      // override HERE is what makes "recreate" apply the narrowed selection.
      const { data: variantOverrideRow } = await db
        .from("listings")
        .select("selected_variant_ids")
        .eq("id", listingId)
        .single();
      const selectedVariantIds =
        (variantOverrideRow as { selected_variant_ids?: number[] | null } | null)
          ?.selected_variant_ids ?? null;

      const designVariantIds = design.printify_variant_ids ?? [];
      if (selectedVariantIds !== null && selectedVariantIds.length > 0) {
        validateVariantIds(selectedVariantIds, designVariantIds);
      }
      const variantIds =
        selectedVariantIds !== null && selectedVariantIds.length > 0
          ? selectedVariantIds
          : designVariantIds;

      log.info({ action: "create_printify_product", record_id: listingId, status: "started" });
      const result = await createHiddenProduct({
        imageUrl: design.image_url ?? "",
        blueprintId: design.printify_blueprint_id,
        printProviderId: design.printify_print_provider_id,
        variantIds,
        title: copy.title,
      });
      productId = result.productId;

      // Data writes to design_packages — Printify-derived facts about this
      // design's mockups + per-variant labels. NOT status/error_message.
      //
      // Preserve any non-Printify mockups (e.g. Dynamic Mockups renders) that
      // were added before this Printify product recreation. Only Printify CDN
      // URLs are replaced with the fresh set from this product creation.
      const nonPrintifyMockups = (design.mockup_urls ?? []).filter(
        (u) => !u.includes("printify.com")
      );
      await db
        .from("design_packages")
        .update({
          mockup_urls: [...nonPrintifyMockups, ...result.mockupUrls],
          mockups_from_actual_design: true,
          printify_variants: result.variants,
        })
        .eq("id", design.id);

      await db
        .from("listings")
        .update({
          printify_product_id: productId,
          // Stamp the sync timestamp so the dashboard can detect stale
          // artwork later — design.updated_at > design_synced_at means the
          // design was edited after this Printify product was generated.
          // Migration 049 trigger handles the auto-rebuild for non-active
          // statuses; for active listings the dashboard renders a badge.
          design_synced_at: new Date().toISOString(),
        })
        .eq("id", listingId);
    }

    // Step 5: Pause at needs_review for operator approval. Clear any prior
    // error_message — a successful run supersedes the previous failure.
    await db
      .from("listings")
      .update({ status: "needs_review", error_message: null })
      .eq("id", listingId);
    log.info({
      action: "paused_for_review",
      record_id: listingId,
      status: "needs_review",
      duration_ms: Date.now() - t0,
    });
    return { listingId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Update only the listings row. design.status/error_message are
    // off-limits per the pipeline contract (see header).
    const { data: current, error: readErr } = await db
      .from("listings")
      .select("retry_count")
      .eq("id", listingId)
      .single();

    let retryCount: number;
    let recordedMessage = message;
    if (readErr) {
      log.error({
        action: "retry_count_read_failed",
        record_id: listingId,
        error: readErr.message,
      });
      recordedMessage = `${message} (retry_count read failed: ${readErr.message}; forcing terminal)`;
      retryCount = MAX_RETRIES;
    } else {
      retryCount = ((current as { retry_count?: number } | null)?.retry_count ?? 0) + 1;
    }

    if (retryCount < MAX_RETRIES) {
      await db
        .from("listings")
        .update({ status: "pending", error_message: recordedMessage, retry_count: retryCount })
        .eq("id", listingId);
    } else {
      await db
        .from("listings")
        .update({ status: "error", error_message: recordedMessage, retry_count: retryCount })
        .eq("id", listingId);
      // Terminal-error alert (AUDIT_4 H2). notifySlack absorbs its own
      // errors so a Slack outage can't mask the original failure.
      await notifySlack(
        `Listing terminal error (id=${listingId}, retry_count=${retryCount}): ${recordedMessage}`,
        { severity: "error" }
      );
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

async function loadListingState(db: Db, listingId: string): Promise<ExistingListingRow | null> {
  const { data } = await db
    .from("listings")
    .select(
      "id, status, title, description, tags, price_usd, printify_product_id, is_active, retry_count"
    )
    .eq("id", listingId)
    .maybeSingle();

  return (data as ExistingListingRow | null) ?? null;
}

interface InventoryFacts {
  blueprintId: number;
  variants: PrintifyVariantOptions[];
}

async function executeEtsyPublish(
  db: Db,
  listingId: string,
  productId: string,
  rawCopy: ListingCopy,
  priceUsd: number,
  mockupUrls: string[],
  mockupsFromActualDesign: boolean,
  inventoryFacts: InventoryFacts,
  selectedMockupUrls?: string[]
): Promise<void> {
  const { ETSY_SHIPPING_PROFILE_ID, ETSY_PRODUCTION_PARTNER_ID, ETSY_READINESS_STATE_ID } = getSettings();

  // Last-line compliance gates immediately before talking to Etsy. These guard
  // against any state where the DB row drifted (e.g. resumePublish picking up
  // stale data) or a config change between the queue insert and the publish.
  // Re-sanitize copy here too — this is the single chokepoint every publish
  // path funnels through, so stripping em dashes once more guarantees none can
  // reach a live listing regardless of how the copy was produced upstream.
  const copy = sanitizeListingCopy(rawCopy);
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
    const materials = blueprintMaterials(inventoryFacts.blueprintId);
    const processing = blueprintProcessingDays(inventoryFacts.blueprintId);
    // Physical specs for Etsy "calculated" shipping profiles (rejected otherwise).
    const itemSpecs = blueprintItemSpecs(inventoryFacts.blueprintId);
    const { listing_id } = await createDraftListing(db, {
      taxonomy_id: taxonomyId,
      who_made: "i_did",
      when_made: "made_to_order",
      is_supply: false,
      // Required by Etsy on create; a placeholder that updateListingInventory
      // immediately overrides per variant.
      quantity: POD_VARIANT_QUANTITY,
      shipping_profile_id: ETSY_SHIPPING_PROFILE_ID,
      readiness_state_id: ETSY_READINESS_STATE_ID,
      production_partner_ids: [ETSY_PRODUCTION_PARTNER_ID],
      title: copy.title,
      description: copy.description,
      price: priceUsd,
      tags: copy.tags,
      ...(materials ? { materials } : {}),
      ...(processing
        ? { processing_min: processing.min, processing_max: processing.max }
        : {}),
      ...(itemSpecs ?? {}),
    });
    etsyListingId = listing_id;
    // Persist immediately, BEFORE attempting image upload or activation, so any
    // failure between here and the final 'active' write doesn't strand the draft.
    await db
      .from("listings")
      .update({ etsy_listing_id: etsyListingId })
      .eq("id", listingId);
  }

  // Variant inventory must land before activation — without it the listing
  // publishes as a single non-variant SKU and buyers can't pick a size. Etsy
  // accepts inventory PUT on a draft listing; idempotent so resume retries
  // overwrite cleanly with the same shape.
  const inventory = buildInventoryFromDesign({
    design: {
      printify_blueprint_id: inventoryFacts.blueprintId,
      printify_variants: inventoryFacts.variants,
    },
    priceUsd,
    readinessStateId: ETSY_READINESS_STATE_ID,
  });
  await updateListingInventory(db, etsyListingId, inventory);

  // Image upload (POST) is NOT idempotent — Etsy appends a new image per POST,
  // so a resume/retry after a partial upload would duplicate the carousel.
  // Skip the ranks Etsy already has by reading the current image count first.
  // In mock mode this count is always 0 (full upload preserved).
  const alreadyUploaded = await getListingImageCount(db, etsyListingId);

  // Determine the effective upload list. If the caller supplied a selection,
  // filter mockupUrls to that subset (preserving the caller's order), silently
  // dropping any URL that isn't actually in the row's mockup_urls (defense-
  // in-depth). An empty or absent selection means "upload all" (current behavior).
  const mockupSet = new Set(mockupUrls);
  const uploadUrls =
    selectedMockupUrls && selectedMockupUrls.length > 0
      ? selectedMockupUrls.filter((u) => mockupSet.has(u))
      : mockupUrls;

  if (uploadUrls.length > MAX_ETSY_LISTING_IMAGES) {
    throw new PublisherError(
      `Selected ${uploadUrls.length} images but Etsy caps a listing at ${MAX_ETSY_LISTING_IMAGES}. ` +
        `Reduce the selection to ${MAX_ETSY_LISTING_IMAGES} or fewer images before publishing.`
    );
  }

  // alt_text per image: short, descriptive, distinct per rank. Etsy uses these
  // for accessibility and image-search SEO. We bound title length with the
  // global cap inside uploadListingImage (250 chars), so no truncation here.
  for (let i = alreadyUploaded; i < uploadUrls.length; i++) {
    const url = uploadUrls[i]!;
    const altText =
      uploadUrls.length === 1
        ? `Product photo of: ${copy.title}`
        : `Product photo ${i + 1} of: ${copy.title}`;
    await uploadListingImage(db, etsyListingId, url, { altText, rank: i + 1 });
  }

  // Activation is the real point of no return: once this PATCH succeeds the
  // listing is LIVE and buyable on Etsy. Persist 'active' immediately so a
  // later failure can't leave a live listing whose DB row still says
  // pending_publish/error (a state the operator can't reconcile).
  await activateListing(db, etsyListingId);
  await db
    .from("listings")
    .update({ status: "active", is_active: true })
    .eq("id", listingId);

  // Printify visibility is cosmetic relative to the Etsy listing already being
  // live, so it's best-effort — a failure here must NOT throw and roll the row
  // back to pending_publish (which would re-run this whole publish).
  try {
    await setProductVisible(productId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    getLogger("listing").warn({
      action: "set_product_visible_failed",
      record_id: listingId,
      printify_product_id: productId,
      error: message,
    });
    await notifySlack(
      `Listing ${listingId} is live on Etsy but Printify product ${productId} could not be made visible: ${message}`,
      { severity: "warn" }
    );
  }
}

export async function resumePublish(
  db: Db,
  listingId: string,
  opts: { selectedMockupUrls?: string[] } = {}
): Promise<void> {
  const log = getLogger("listing");
  const t0 = Date.now();

  const { data: row, error: rowErr } = await db
    .from("listings")
    .select(
      "status, printify_product_id, title, description, tags, price_usd, retry_count, design_package_id, selected_variant_ids"
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
    selected_variant_ids: number[] | null;
  };

  if (listing.status !== "pending_publish") {
    throw new PublisherError(
      `resumePublish requires status='pending_publish', got '${listing.status}'`
    );
  }

  if (!listing.printify_product_id) {
    throw new PublisherError(`Listing ${listingId} has no printify_product_id`);
  }

  // Fetch mockup_urls + provenance flag + inventory facts from the joined
  // design_packages row. The provenance flag must travel with the mockups so
  // the downstream Etsy publish can re-verify image-policy compliance even on
  // a resumed/retried run; printify_blueprint_id + printify_variants are what
  // executeEtsyPublish needs to PUT the Etsy inventory.
  const { data: designRow } = await db
    .from("listings")
    .select(
      "design_packages(mockup_urls,mockups_from_actual_design,printify_blueprint_id,printify_variants)"
    )
    .eq("id", listingId)
    .single();

  const designJoin =
    (
      designRow as {
        design_packages?: {
          mockup_urls?: string[] | null;
          mockups_from_actual_design?: boolean | null;
          printify_blueprint_id?: number | null;
          printify_variants?:
            | Array<{ id: number; values: string[] }>
            | null;
        } | null;
      } | null
    )?.design_packages ?? null;

  const mockupUrls: string[] = designJoin?.mockup_urls ?? [];
  const mockupsFromActualDesign: boolean = designJoin?.mockups_from_actual_design ?? false;
  const blueprintId = designJoin?.printify_blueprint_id ?? null;
  let printifyVariants = designJoin?.printify_variants ?? [];

  if (blueprintId === null) {
    throw new PublisherError(
      `Listing ${listingId}: joined design_packages.printify_blueprint_id is missing`
    );
  }

  // Apply the operator's variant override when set, narrowing the inventory
  // to only the selected sizes/colors before building the Etsy inventory PUT.
  if (listing.selected_variant_ids !== null && listing.selected_variant_ids.length > 0) {
    validateVariantIds(
      listing.selected_variant_ids,
      printifyVariants.map((v) => v.id)
    );
    printifyVariants = printifyVariants.filter((v) =>
      listing.selected_variant_ids!.includes(v.id)
    );
  }

  if (printifyVariants.length === 0) {
    throw new PublisherError(
      `Listing ${listingId}: joined design_packages.printify_variants is empty — Printify product create did not record variant labels`
    );
  }

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
      mockupsFromActualDesign,
      { blueprintId, variants: printifyVariants },
      opts.selectedMockupUrls
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
      // Pipeline contract: do NOT propagate the listing's error to
      // design_packages. The design's job ended when Listing claimed it;
      // any failure during publish lives entirely on the listings row.
      // (See header on publishOne for the full contract.)
      // Terminal-error alert (AUDIT_4 H2). resumePublish shares the retry
      // budget with publishOne, so the alert fires from whichever function
      // reaches MAX_RETRIES first.
      await notifySlack(
        `Listing terminal error in resume (id=${listingId}, retry_count=${retryCount}): ${message}`,
        { severity: "error" }
      );
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

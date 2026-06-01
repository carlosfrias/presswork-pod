"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

// Print cost for the only currently-supported blueprint (Gildan 64000).
// Mirrors GILDAN_64000_PRINT_COST_USD in packages/listing/src/constants.ts.
const PRINT_COST_USD = 10.09;
const PRICING_FLOOR_MULTIPLIER = 2.5;
const PRICE_FLOOR_USD = PRINT_COST_USD * PRICING_FLOOR_MULTIPLIER; // $25.23
import {
  ListingCopySchema,
  ComplianceError,
  ensureAiDisclosure,
  ensureValidTags,
  stripEmDashes,
  sanitizeListingCopy,
  validateCopyCompliance,
  updateActiveListing as updateActiveListingOnEtsy,
  deactivateEtsyListing,
  dynamicMockupsTemplates,
  renderMockup,
  DynamicMockupsApiError,
} from "@presswork/shared";
import { resumePublish } from "@presswork/listing/publish";
import { serviceClient } from "@/lib/supabase/server";
import { requireOwnerEmail } from "@/lib/auth";

async function assertOwner() {
  const email = await requireOwnerEmail();
  if (!email) throw new Error("Unauthorized");
  return email;
}

const idSchema = z.string().uuid();

export async function approveListing(formData: FormData) {
  const email = await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  const db = serviceClient();

  // Re-fetch the listing to confirm it's still at needs_review — guards
  // against a stale tab approving something that already moved on.
  const { data: row } = await db
    .from("listings")
    .select("status, title, description, tags")
    .eq("id", id)
    .maybeSingle();
  if (!row) throw new Error("Listing not found");
  if (row.status !== "needs_review") {
    throw new Error(`Cannot approve from status='${row.status}'`);
  }

  const { error } = await db
    .from("listings")
    .update({
      status: "pending_publish",
      error_message: null,
      retry_count: 0,
    })
    .eq("id", id)
    .eq("status", "needs_review"); // optimistic concurrency guard
  if (error) throw new Error(`Approve failed: ${error.message}`);

  const { error: usageErr } = await db.from("llm_usage").insert({
    agent: "listing",
    provider: "etsy",
    operation: "manual_approve",
    metadata: { listing_id: id, approver: email },
  });
  if (usageErr) console.error("llm_usage insert failed:", usageErr.message);

  revalidatePath("/listings");
  revalidatePath(`/listings/${id}`);
}

/**
 * Save any pending copy edits and approve in one shot. Called when the
 * operator clicks "Approve & publish" directly from the CopyEditor form,
 * so edits typed but not yet saved are not silently discarded.
 *
 * Runs the same validation path as updateListingCopy, then transitions
 * status to pending_publish in the same DB write. Only valid from needs_review.
 */
export async function approveListingWithCopy(formData: FormData) {
  const email = await assertOwner();
  const id = idSchema.parse(formData.get("id"));

  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const tagsRaw = String(formData.get("tags") ?? "");
  const tags = tagsRaw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const priceRaw = formData.get("price");
  const priceUsd =
    priceRaw == null || String(priceRaw).trim() === ""
      ? null
      : Number(priceRaw);
  if (priceUsd !== null) {
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
      throw new Error(`Price must be a positive number, got "${priceRaw}".`);
    }
    if (priceUsd < PRICE_FLOOR_USD) {
      throw new Error(
        `Price $${priceUsd.toFixed(2)} is below the required floor of $${PRICE_FLOOR_USD.toFixed(2)} (print cost $${PRINT_COST_USD.toFixed(2)} × ${PRICING_FLOOR_MULTIPLIER}).`
      );
    }
  }

  const db = serviceClient();
  const { data: row } = await db
    .from("listings")
    .select("status")
    .eq("id", id)
    .maybeSingle();
  if (!row) throw new Error("Listing not found");
  if (row.status !== "needs_review") {
    throw new Error(`Cannot approve from status='${row.status}'`);
  }

  const descriptionWithDisclosure = ensureAiDisclosure(stripEmDashes(description));
  const cleanedTags = ensureValidTags(tags);
  const parsed = ListingCopySchema.safeParse({
    title: stripEmDashes(title),
    description: descriptionWithDisclosure,
    tags: cleanedTags,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `Copy validation failed: ${issue?.path.join(".")} — ${issue?.message}`
    );
  }
  try {
    validateCopyCompliance(parsed.data);
  } catch (err) {
    if (err instanceof ComplianceError) throw new Error(err.message);
    throw err;
  }

  const { error } = await db
    .from("listings")
    .update({
      title: parsed.data.title,
      description: parsed.data.description,
      tags: parsed.data.tags,
      ...(priceUsd !== null ? { price_usd: priceUsd } : {}),
      status: "pending_publish",
      error_message: null,
      retry_count: 0,
    })
    .eq("id", id)
    .eq("status", "needs_review");
  if (error) throw new Error(`Approve failed: ${error.message}`);

  const { error: usageErr } = await db.from("llm_usage").insert({
    agent: "listing",
    provider: "etsy",
    operation: "manual_approve",
    metadata: { listing_id: id, approver: email },
  });
  if (usageErr) console.error("llm_usage insert failed:", usageErr.message);

  revalidatePath("/listings");
  revalidatePath(`/listings/${id}`);
}

export async function rejectListing(formData: FormData) {
  const email = await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  const reason = (formData.get("reason") ?? "").toString().slice(0, 500);
  // When checked, reject because the underlying *design* is bad (not the
  // copy/price). Send the design back to needs_review so the operator can
  // Regen / Re-mask / Replace, and free it for re-claim by nulling this
  // listing's design_package_id (preserves the listings row as audit, but
  // breaks the FK so the migration-046 NOT EXISTS guard lets the design
  // be claimed fresh once it's re-approved).
  const sendDesignBack = formData.get("send_design_back") === "on";
  const db = serviceClient();

  // Re-fetch the listing to confirm it's still at needs_review — guards
  // against a stale tab rejecting something that already moved on
  // (publishing, active, or another terminal state). Mirrors the
  // approveListing guard at the top of this file (AUDIT_4 H3).
  const { data: row } = await db
    .from("listings")
    .select("status")
    .eq("id", id)
    .maybeSingle();
  if (!row) throw new Error("Listing not found");
  // 'needs_review' is the normal pre-publish reject path. 'error' is also
  // allowed so the Errors card on the listings page can dismiss a row that
  // the operator decides isn't worth fixing — same destination either way
  // (status='error' with the manual-reject message stamped on top).
  if (row.status !== "needs_review" && row.status !== "error") {
    throw new Error(`Cannot reject from status='${row.status}'`);
  }

  // Look up the linked design ahead of the listings update if we'll need
  // to flip it. Doing this read first avoids the race where the listings
  // update would null the FK before we could read it.
  let designPackageIdForRework: string | null = null;
  if (sendDesignBack) {
    const { data: linkRow } = await db
      .from("listings")
      .select("design_package_id")
      .eq("id", id)
      .maybeSingle();
    designPackageIdForRework =
      ((linkRow as { design_package_id?: string | null } | null)
        ?.design_package_id) ?? null;
  }

  const reasonNote = `manual reject (${email})${sendDesignBack ? " — design returned to review" : ""}: ${reason || "no reason given"}`;

  const { error } = await db
    .from("listings")
    .update({
      status: "error",
      error_message: reasonNote,
      // Null the FK when sending the design back: lets the migration-046
      // claim RPC pick the design up again as a fresh listing once the
      // operator re-approves it on the design page.
      ...(sendDesignBack ? { design_package_id: null } : {}),
    })
    .eq("id", id)
    .in("status", ["needs_review", "error"]); // optimistic concurrency guard
  if (error) throw new Error(`Reject failed: ${error.message}`);

  if (sendDesignBack && designPackageIdForRework) {
    // Flip the design back to needs_review so the operator sees it on the
    // Design page review queue and can Regen/Re-mask/Replace before
    // re-approving. error_message cleared since this is a fresh review pass,
    // not a stuck-error state.
    const { error: designErr } = await db
      .from("design_packages")
      .update({ status: "needs_review", error_message: null })
      .eq("id", designPackageIdForRework);
    if (designErr) {
      throw new Error(
        `Reject succeeded but failed to send design back: ${designErr.message}`,
      );
    }
    // Bonus revalidate: the design page's review queue now has a new entry.
    revalidatePath("/design");
  }

  revalidatePath("/listings");
  revalidatePath(`/listings/${id}`);
}

/**
 * Save operator edits to listing copy. Only allowed when the listing is at
 * `needs_review` — once approved, the copy is what was approved. Runs the
 * exact same validators the publisher runs (`validateCopyCompliance` +
 * `ListingCopySchema`) so an invalid edit fails here, not later when the
 * publish pipeline trips on it.
 *
 * Tags input is a single comma-separated string (matches Etsy's tag UX).
 * Empty tags after splitting/trimming are dropped.
 */
export async function updateListingCopy(formData: FormData) {
  await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const tagsRaw = String(formData.get("tags") ?? "");
  const tags = tagsRaw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  // Optional — when the form omits price, leave the existing value alone.
  // When present, validate against the pricing floor before persisting.
  const priceRaw = formData.get("price");
  const priceUsd =
    priceRaw == null || String(priceRaw).trim() === ""
      ? null
      : Number(priceRaw);
  if (priceUsd !== null) {
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
      throw new Error(`Price must be a positive number, got "${priceRaw}".`);
    }
    if (priceUsd < PRICE_FLOOR_USD) {
      throw new Error(
        `Price $${priceUsd.toFixed(2)} is below the required floor of $${PRICE_FLOOR_USD.toFixed(2)} (print cost $${PRINT_COST_USD.toFixed(2)} × ${PRICING_FLOOR_MULTIPLIER}).`
      );
    }
  }

  const db = serviceClient();
  const { data: row } = await db
    .from("listings")
    .select("status")
    .eq("id", id)
    .maybeSingle();
  if (!row) throw new Error("Listing not found");
  // 'needs_review' is the normal pre-publish edit window. 'error' is allowed
  // too so the operator can fix the copy that broke the publisher (long tags,
  // forbidden terms, missing fields) without first re-running the agent. Save
  // clears error_message; operator clicks Retry from error to re-queue.
  if (row.status !== "needs_review" && row.status !== "error") {
    throw new Error(
      `Cannot edit copy from status='${row.status}' — editable statuses are 'needs_review' and 'error'.`
    );
  }

  // Schema parse first (catches max-length, all-caps title, missing AI
  // disclosure). Compliance gates next (forbidden terms, off-platform).
  // Either failure throws a message the form surfaces back to the operator.
  // Auto-fix the two common gates the operator can miss:
  //   - AI disclosure (Etsy requires the verbatim string in the description;
  //     we own the wording, so append if missing).
  //   - Tags (Etsy caps each at 20 chars and the array at 13; we trim
  //     word-boundary, drop dups + empties, cap to 13).
  // Same helpers the copywriter runs after a Claude call. ListingCopySchema's
  // refines remain as a final-invariant check but should never fire now.
  const descriptionWithDisclosure = ensureAiDisclosure(stripEmDashes(description));
  const cleanedTags = ensureValidTags(tags);
  const parsed = ListingCopySchema.safeParse({
    title: stripEmDashes(title),
    description: descriptionWithDisclosure,
    tags: cleanedTags,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `Copy validation failed: ${issue?.path.join(".")} — ${issue?.message}`
    );
  }
  try {
    validateCopyCompliance(parsed.data);
  } catch (err) {
    if (err instanceof ComplianceError) throw new Error(err.message);
    throw err;
  }

  const { error } = await db
    .from("listings")
    .update({
      title: parsed.data.title,
      description: parsed.data.description,
      tags: parsed.data.tags,
      ...(priceUsd !== null ? { price_usd: priceUsd } : {}),
      // Editing the copy implicitly clears the prior error_message — the
      // operator is signalling they've addressed whatever was wrong.
      error_message: null,
    })
    .eq("id", id)
    .in("status", ["needs_review", "error"]);
  if (error) throw new Error(`Save failed: ${error.message}`);

  revalidatePath("/listings");
  revalidatePath(`/listings/${id}`);
}

/**
 * Save operator edits to the copy of an already-active listing. DB-only —
 * the change does NOT propagate to Etsy until pushListingToEtsy runs.
 *
 * Two-step UX (per the dashboard plan): Save stages the edit so the operator
 * can review → fix → save → Push when ready, without surprising live changes
 * on Etsy on every keystroke save.
 */
export async function updateActiveListingCopy(formData: FormData) {
  await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const tagsRaw = String(formData.get("tags") ?? "");
  const tags = tagsRaw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  // Optional — when the form omits price, leave the existing value alone.
  // When present, validate against the pricing floor before persisting.
  const priceRaw = formData.get("price");
  const priceUsd =
    priceRaw == null || String(priceRaw).trim() === ""
      ? null
      : Number(priceRaw);
  if (priceUsd !== null) {
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
      throw new Error(`Price must be a positive number, got "${priceRaw}".`);
    }
    if (priceUsd < PRICE_FLOOR_USD) {
      throw new Error(
        `Price $${priceUsd.toFixed(2)} is below the required floor of $${PRICE_FLOOR_USD.toFixed(2)} (print cost $${PRINT_COST_USD.toFixed(2)} × ${PRICING_FLOOR_MULTIPLIER}).`
      );
    }
  }

  const db = serviceClient();
  const { data: row } = await db
    .from("listings")
    .select("status")
    .eq("id", id)
    .maybeSingle();
  if (!row) throw new Error("Listing not found");
  if (row.status !== "active") {
    throw new Error(
      `Cannot edit active-listing copy from status='${row.status}' — this action only handles 'active'.`
    );
  }

  // Auto-fix the two common gates the operator can miss:
  //   - AI disclosure (Etsy requires the verbatim string in the description;
  //     we own the wording, so append if missing).
  //   - Tags (Etsy caps each at 20 chars and the array at 13; we trim
  //     word-boundary, drop dups + empties, cap to 13).
  // Same helpers the copywriter runs after a Claude call. ListingCopySchema's
  // refines remain as a final-invariant check but should never fire now.
  const descriptionWithDisclosure = ensureAiDisclosure(stripEmDashes(description));
  const cleanedTags = ensureValidTags(tags);
  const parsed = ListingCopySchema.safeParse({
    title: stripEmDashes(title),
    description: descriptionWithDisclosure,
    tags: cleanedTags,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `Copy validation failed: ${issue?.path.join(".")} — ${issue?.message}`
    );
  }
  try {
    validateCopyCompliance(parsed.data);
  } catch (err) {
    if (err instanceof ComplianceError) throw new Error(err.message);
    throw err;
  }

  // updated_at advances via the auto-update trigger; the dashboard compares
  // it to last_pushed_at to enable the Push button.
  const { error } = await db
    .from("listings")
    .update({
      title: parsed.data.title,
      description: parsed.data.description,
      tags: parsed.data.tags,
      ...(priceUsd !== null ? { price_usd: priceUsd } : {}),
    })
    .eq("id", id)
    .eq("status", "active");
  if (error) throw new Error(`Save failed: ${error.message}`);

  revalidatePath("/listings");
  revalidatePath(`/listings/${id}`);
}

/**
 * Push the dashboard's current copy to the live Etsy listing via
 * PATCH /v3/application/shops/{shop_id}/listings/{listing_id}. Etsy applies
 * the change in-place; the listing remains active.
 *
 * Re-runs validateCopyCompliance against the current row before the API
 * call (defense-in-depth — Save also ran the gates, but config or constants
 * could have shifted between Save and Push).
 *
 * On success: writes last_pushed_at = now() so the Push button switches
 * back to "All changes pushed". On Etsy failure: writes the error to
 * listings.error_message and surfaces in the existing error UI.
 */
export async function pushListingToEtsy(formData: FormData) {
  await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  const db = serviceClient();

  const { data: row } = await db
    .from("listings")
    .select("status, etsy_listing_id, title, description, tags")
    .eq("id", id)
    .maybeSingle();
  if (!row) throw new Error("Listing not found");
  if (row.status !== "active") {
    throw new Error(
      `Cannot push from status='${row.status}' — only 'active' listings have a live Etsy row to update.`
    );
  }
  if (!row.etsy_listing_id) {
    throw new Error(
      "Listing has no etsy_listing_id — was it ever published?"
    );
  }
  if (!row.title || !row.description || !row.tags) {
    throw new Error("Listing is missing copy fields — save edits first.");
  }

  // Sanitize before the live update so em dashes never reach Etsy, even for
  // legacy rows saved before em-dash stripping landed.
  const copy = sanitizeListingCopy({
    title: row.title as string,
    description: row.description as string,
    tags: row.tags as string[],
  });
  // Defense-in-depth: re-run the compliance gates immediately before the
  // Etsy call. Mirrors the publisher's executeEtsyPublish pattern.
  try {
    validateCopyCompliance(copy);
  } catch (err) {
    if (err instanceof ComplianceError) {
      // Persist as the listings error so the operator sees it on the dash.
      await db
        .from("listings")
        .update({ error_message: err.message })
        .eq("id", id);
      throw new Error(err.message);
    }
    throw err;
  }

  try {
    await updateActiveListingOnEtsy(db, row.etsy_listing_id as number, copy);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .from("listings")
      .update({ error_message: `push failed: ${message}` })
      .eq("id", id);
    throw new Error(`Etsy push failed: ${message}`);
  }

  // Persist the sanitized copy so the DB row matches what is now live on Etsy.
  await db
    .from("listings")
    .update({
      title: copy.title,
      description: copy.description,
      tags: copy.tags,
      last_pushed_at: new Date().toISOString(),
      error_message: null,
    })
    .eq("id", id);

  revalidatePath("/listings");
  revalidatePath(`/listings/${id}`);
}

/**
 * Replace a listing's mockup_urls with a fresh render from Dynamic Mockups.
 *
 * Reuses the existing design.image_url as the source asset (same image
 * Printify composited for the original mockups). The blueprint determines
 * which Dynamic Mockups template + smart-object UUIDs to use; the registry
 * lives in @presswork/shared/dynamic-mockups.
 *
 * Always writes to design_packages.mockup_urls (not listings) because that's
 * where the publisher reads listing-image URLs from. Keeps
 * mockups_from_actual_design = true — Dynamic Mockups composites the design
 * into a smart-object slot, so the resulting image still satisfies Etsy
 * compliance rule 4 (images come from the actual design file).
 *
 * Refuses if no template is configured for the blueprint, or if the design
 * has no image_url to send.
 */
export async function generateDynamicMockups(formData: FormData) {
  await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  const db = serviceClient();

  const { data: row } = await db
    .from("listings")
    .select(
      `id, status, design_packages:design_packages!listings_design_package_id_fkey(
        id, image_url, printify_blueprint_id, mockup_urls
      )`
    )
    .eq("id", id)
    .maybeSingle();
  if (!row) throw new Error("Listing not found");

  const dp = (row as unknown as {
    design_packages?: {
      id: string;
      image_url: string | null;
      printify_blueprint_id: number | null;
      mockup_urls: string[] | null;
    } | null;
  }).design_packages;

  if (!dp) throw new Error("Listing has no joined design_package");
  if (!dp.image_url) {
    throw new Error("design has no image_url to send to Dynamic Mockups");
  }
  if (!dp.printify_blueprint_id) {
    throw new Error("design has no printify_blueprint_id");
  }

  const templates = dynamicMockupsTemplates(dp.printify_blueprint_id);
  if (templates.length === 0) {
    throw new Error(
      `No Dynamic Mockups template registered for blueprint ${dp.printify_blueprint_id}. ` +
        "Add one to DYNAMIC_MOCKUPS_TEMPLATES_BY_BLUEPRINT in packages/shared/src/dynamic-mockups.ts."
    );
  }

  // Render all registered templates in parallel — each produces one export_path.
  let newPaths: string[];
  try {
    newPaths = await Promise.all(
      templates.map((t, i) =>
        renderMockup({
          mockupUuid: t.mockupUuid,
          smartObjectUuid: t.smartObjectUuid,
          designUrl: dp.image_url!,
          options: {
            imageFormat: "jpg",
            imageSize: 2000,
            label: `listing-${id}-t${i}`,
          },
        })
      )
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof DynamicMockupsApiError) {
      throw new Error(message);
    }
    throw new Error(`Dynamic Mockups render failed: ${message}`);
  }

  // Order: print image (imageUrl, always first in carousel) → DM renders →
  // Printify composites. Printify URLs contain "printify.com"; everything
  // else is treated as a DM or operator-added image. Old DM renders are
  // replaced (not accumulated) so re-generating doesn't bloat the carousel.
  const printifyMocks = (dp.mockup_urls ?? []).filter(u => u.includes("printify.com"));
  const { error } = await db
    .from("design_packages")
    .update({
      mockup_urls: [...newPaths, ...printifyMocks],
      mockups_from_actual_design: true,
    })
    .eq("id", dp.id);
  if (error) throw new Error(`Failed to write mockup_urls: ${error.message}`);

  revalidatePath("/listings");
  revalidatePath(`/listings/${id}`);
}

export async function regenerateCopy(formData: FormData) {
  await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  const db = serviceClient();
  const { error } = await db
    .from("listings")
    .update({
      status: "pending",
      title: null,
      description: null,
      tags: null,
      error_message: null,
    })
    .eq("id", id);
  if (error) throw new Error(`Regenerate copy failed: ${error.message}`);
  revalidatePath("/listings");
  revalidatePath(`/listings/${id}`);
}

export async function recreatePrintifyProduct(formData: FormData) {
  await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  const db = serviceClient();
  const { error } = await db
    .from("listings")
    .update({
      status: "pending",
      printify_product_id: null,
      error_message: null,
    })
    .eq("id", id);
  if (error) throw new Error(`Recreate Printify product failed: ${error.message}`);
  revalidatePath("/listings");
  revalidatePath(`/listings/${id}`);
}

/**
 * Save the operator's per-listing variant-ID override. An empty selection
 * (all unchecked) is stored as NULL, meaning "inherit the full design set".
 *
 * Validates the selected IDs against the design package's available set
 * before writing — mirrors the validateCopyCompliance catch pattern.
 */
export async function updateListingVariants(formData: FormData) {
  await assertOwner();
  const id = idSchema.parse(formData.get("id"));

  const selected = formData
    .getAll("selectedVariantIds")
    .map(Number)
    .filter((n) => !Number.isNaN(n));

  const db = serviceClient();

  // Read the authoritative available IDs from the design package.
  const { data: row } = await db
    .from("listings")
    .select(
      `id, design_packages:design_packages!listings_design_package_id_fkey(
        printify_variant_ids
      )`
    )
    .eq("id", id)
    .maybeSingle();
  if (!row) throw new Error("Listing not found");

  const dp = (row as unknown as {
    design_packages?: { printify_variant_ids: number[] | null } | null;
  }).design_packages;
  const available: number[] = dp?.printify_variant_ids ?? [];

  if (selected.length > 0) {
    const { validateVariantIds, VariantSelectionError } = await import(
      "@presswork/shared"
    );
    try {
      validateVariantIds(selected, available);
    } catch (err) {
      if (err instanceof VariantSelectionError) throw new Error(err.message);
      throw err;
    }
  }

  const { error } = await db
    .from("listings")
    .update({ selected_variant_ids: selected.length > 0 ? selected : null })
    .eq("id", id);
  if (error) throw new Error(`Save variant selection failed: ${error.message}`);

  revalidatePath("/listings");
  revalidatePath(`/listings/${id}`);
}

export async function retryListing(formData: FormData) {
  await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  const db = serviceClient();
  const { error } = await db
    .from("listings")
    .update({
      status: "pending",
      retry_count: 0,
      error_message: null,
    })
    .eq("id", id);
  if (error) throw new Error(`Retry failed: ${error.message}`);
  revalidatePath("/listings");
  revalidatePath(`/listings/${id}`);
}

/**
 * Revert a listing one step back in the pipeline without touching Etsy:
 *   pending_publish → needs_review   (un-approves; no Etsy listing exists yet)
 *   active → pending_publish         (best-effort Etsy deactivation; continues on failure)
 */
export async function backUpListing(formData: FormData) {
  await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  const db = serviceClient();

  const { data: row } = await db
    .from("listings")
    .select("status, etsy_listing_id")
    .eq("id", id)
    .maybeSingle();
  if (!row) throw new Error("Listing not found");

  if (row.status === "active") {
    if (row.etsy_listing_id) {
      try {
        await deactivateEtsyListing(db, row.etsy_listing_id as number);
      } catch (err) {
        console.error("backUpListing: Etsy deactivation failed (continuing):", err);
      }
    }
    const { error } = await db
      .from("listings")
      .update({ status: "pending_publish", error_message: null })
      .eq("id", id)
      .eq("status", "active");
    if (error) throw new Error(`Back up failed: ${error.message}`);
  } else if (row.status === "pending_publish") {
    const { error } = await db
      .from("listings")
      .update({ status: "needs_review", error_message: null })
      .eq("id", id)
      .eq("status", "pending_publish");
    if (error) throw new Error(`Back up failed: ${error.message}`);
  } else {
    throw new Error(`Cannot back up from status='${row.status}'`);
  }

  revalidatePath("/listings");
  revalidatePath(`/listings/${id}`);
}

/**
 * Permanently delete a listing row. For active listings, best-effort Etsy
 * deactivation runs first. Optionally sends the associated design back to
 * needs_review so it can be reopened.
 *
 * Valid statuses: error, pending_publish, active.
 */
export async function deleteListing(formData: FormData) {
  await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  const sendDesignBack = formData.get("send_design_back") === "on";
  const db = serviceClient();

  const { data: row } = await db
    .from("listings")
    .select("status, etsy_listing_id, design_package_id")
    .eq("id", id)
    .maybeSingle();
  if (!row) throw new Error("Listing not found");

  const deletableStatuses = ["error", "pending_publish", "active"];
  if (!deletableStatuses.includes(row.status)) {
    throw new Error(`Cannot delete listing with status='${row.status}'`);
  }

  if (row.status === "active" && row.etsy_listing_id) {
    try {
      await deactivateEtsyListing(db, row.etsy_listing_id as number);
    } catch (err) {
      console.error("deleteListing: Etsy deactivation failed (continuing):", err);
    }
  }

  const { error } = await db.from("listings").delete().eq("id", id);
  if (error) throw new Error(`Delete failed: ${error.message}`);

  // Send the linked design back to review, if requested. The .eq('status',
  // 'approved') guard means this no-ops when the design has already moved on;
  // capture the result so a silent miss is surfaced rather than swallowed.
  let sendBackWarning: string | null = null;
  if (sendDesignBack && row.design_package_id) {
    const { data: updated, error: sendBackErr } = await db
      .from("design_packages")
      .update({ status: "needs_review", error_message: null })
      .eq("id", row.design_package_id)
      .eq("status", "approved")
      .select("id");
    if (sendBackErr) {
      sendBackWarning = `the linked design could not be returned to review: ${sendBackErr.message}`;
    } else if (!updated || updated.length === 0) {
      sendBackWarning =
        "the linked design was not returned to review — it is no longer in 'approved' status";
    }
  }

  revalidatePath("/listings");
  revalidatePath("/design");

  if (sendBackWarning) {
    throw new Error(`Listing deleted, but ${sendBackWarning}.`);
  }
}

/**
 * Publish a single listing to Etsy immediately, charging the $0.20 Etsy
 * listing fee. Only valid when the listing is at status='pending_publish'.
 *
 * Calls resumePublish from @presswork/listing, which drives the full publish
 * pipeline: compliance gates, createDraftListing, inventory PUT, image upload,
 * activateListing, Printify setProductVisible. The listing transitions through
 * 'publishing' → 'active' (or back to 'pending_publish'/'error' on failure).
 *
 * The dashboard's runtime env must include:
 *   ETSY_PRODUCTION_PARTNER_ID, ETSY_SHIPPING_PROFILE_ID,
 *   ETSY_READINESS_STATE_ID, ETSY_ACCESS_TOKEN, ETSY_REFRESH_TOKEN,
 *   ETSY_API_KEY, ETSY_API_SECRET, ETSY_SHOP_ID, PRINTIFY_API_TOKEN
 * Set ETSY_MOCK_MODE=true to exercise the full pipeline without live Etsy
 * credentials (see packages/shared/src/etsy-mock.ts).
 */
export async function publishListingNow(formData: FormData): Promise<void> {
  await assertOwner();
  const id = idSchema.parse(formData.get("id"));
  const db = serviceClient();

  // Stale-tab guard: confirm the listing is still at pending_publish before
  // incurring the $0.20 Etsy fee. Mirrors the approveListing guard pattern.
  const { data: row } = await db
    .from("listings")
    .select("status")
    .eq("id", id)
    .maybeSingle();
  if (!row) throw new Error("Listing not found");
  if (row.status !== "pending_publish") {
    throw new Error(
      `Cannot publish: listing is at status='${row.status}', expected 'pending_publish'. ` +
        "Refresh the page and try again."
    );
  }

  // Parse optional image selection from the form. Each checked checkbox posts
  // its value under the same name, so getAll returns the ordered array.
  const rawSelectedUrls = formData.getAll("selectedImageUrls").map(String);
  const selectedImageUrlsResult = z.string().url().array().safeParse(rawSelectedUrls);
  if (!selectedImageUrlsResult.success) {
    throw new Error(
      `Invalid selectedImageUrls: ${selectedImageUrlsResult.error.message}`
    );
  }
  const selectedImageUrls = selectedImageUrlsResult.data;

  // resumePublish drives the full Etsy publish pipeline and owns all DB writes
  // on both success and failure paths. On failure it sets the row back to
  // 'pending_publish' (or 'error' after MAX_RETRIES) and rethrows so the
  // server action surfaces the error to the UI.
  await resumePublish(
    db,
    id,
    selectedImageUrls.length > 0 ? { selectedMockupUrls: selectedImageUrls } : {}
  );

  revalidatePath("/listings");
  revalidatePath(`/listings/${id}`);
}

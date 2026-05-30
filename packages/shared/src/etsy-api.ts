import Bottleneck from "bottleneck";
import retry from "async-retry";
import { z } from "zod";
import type { Db } from "./db.js";
import { getSettings } from "./config.js";
import { getValidAccessToken } from "./etsy-auth.js";
import { isMockMode, mockEtsyResponse } from "./etsy-mock.js";
import {
  ETSY_IMAGE_DOWNLOAD_TIMEOUT_MS,
  ETSY_IMAGE_MAX_BYTES,
} from "./constants.js";

export class EtsyApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "EtsyApiError";
  }
}

// Shared limiter: 8 req/sec across all Etsy API wrappers. Etsy's documented
// ceiling is 10 req/sec; the headroom absorbs the token-refresh + create +
// image-upload + activate burst that previously hit 429.
const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 125 });

// Misbehaving servers can send wildly large Retry-After values. Cap so a
// single 429 can't freeze the whole listing pipeline (single-concurrency).
const MAX_RETRY_AFTER_MS = 60_000;

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const asInt = Number(header);
  if (Number.isFinite(asInt) && asInt >= 0) {
    return Math.min(asInt * 1000, MAX_RETRY_AFTER_MS);
  }
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) {
    return Math.min(Math.max(asDate - Date.now(), 0), MAX_RETRY_AFTER_MS);
  }
  return null;
}

export async function etsyFetch(db: Db, path: string, init: RequestInit = {}): Promise<unknown> {
  const { ETSY_API_KEY, ETSY_API_SECRET } = getSettings();

  // Mock mode: still rate-limit to preserve realistic timing (and let the
  // limiter's bookkeeping continue to track mock calls), but skip the network
  // entirely. The path passed to the mock dispatcher matches what the real
  // openapi.etsy.com URL would have used — fixtures match against /application/...
  if (isMockMode()) {
    return limiter.schedule(async () => {
      const method = (init.method ?? "GET").toUpperCase();
      return mockEtsyResponse(method, path, init.body ?? null);
    });
  }

  return limiter.schedule(() =>
    retry(
      async (bail) => {
        const token = await getValidAccessToken(db);
        const res = await fetch(`https://openapi.etsy.com/v3${path}`, {
          ...init,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            // This Etsy app requires the combined "keystring:shared_secret"
            // form in x-api-key; the keystring alone returns
            // "Shared secret is required in x-api-key header." OAuth (etsy-auth.ts)
            // still uses ETSY_API_KEY alone as the client_id.
            "x-api-key": `${ETSY_API_KEY}:${ETSY_API_SECRET}`,
            ...(init.headers as Record<string, string> | undefined),
          },
        });

        if (!res.ok) {
          const body = await res.text();
          if (res.status !== 429 && res.status < 500) {
            bail(new EtsyApiError(`Etsy ${res.status}: ${body}`, res.status));
            return;
          }
          // Honor Retry-After on 429 (parity with the Printify client). Cap
          // the wait so a runaway header can't stall the pipeline.
          if (res.status === 429) {
            const waitMs = parseRetryAfter(res.headers.get("Retry-After"));
            if (waitMs !== null) {
              await new Promise((r) => setTimeout(r, waitMs));
            }
          }
          throw new EtsyApiError(`Etsy ${res.status}: ${body}`, res.status);
        }

        // 204 No Content (e.g. DELETE) has no body — return null rather than
        // throwing a JSON parse error.
        if (res.status === 204 || res.headers.get("content-length") === "0") {
          return null;
        }

        return res.json();
      },
      { retries: 3, factor: 2, minTimeout: 500 }
    )
  );
}

// ── Receipt schemas ────────────────────────────────────────────────────────────

const ReceiptVariationSchema = z.object({
  property_id: z.number().optional(),
  value_id: z.number().optional(),
  formatted_name: z.string().optional(),
  formatted_value: z.string().optional(),
});

const ReceiptLineItemSchema = z.object({
  listing_id: z.number(),
  quantity: z.number().int(),
  price: z.object({ amount: z.number(), divisor: z.number(), currency_code: z.string() }),
  // Etsy returns variations only when the listing has any; missing for single-
  // variant blueprints. We default to [] so the resolver doesn't branch on
  // undefined.
  variations: z.array(ReceiptVariationSchema).optional().default([]),
});

export const EtsyReceiptSchema = z.object({
  receipt_id: z.number(),
  buyer_user_id: z.number(),
  buyer_email: z.string().optional(),
  name: z.string(),
  first_line: z.string(),
  second_line: z.string().nullable().optional(),
  city: z.string(),
  state: z.string().nullable().optional(),
  zip: z.string(),
  country_iso: z.string(),
  grandtotal: z.object({ amount: z.number(), divisor: z.number(), currency_code: z.string() }),
  transactions: z.array(ReceiptLineItemSchema),
});

export type EtsyReceipt = z.infer<typeof EtsyReceiptSchema>;

export async function getReceipt(db: Db, receiptId: string | number): Promise<EtsyReceipt> {
  const { ETSY_SHOP_ID } = getSettings();
  const data = await etsyFetch(db, `/application/shops/${ETSY_SHOP_ID}/receipts/${receiptId}`);
  return EtsyReceiptSchema.parse(data);
}

export async function listReceipts(
  db: Db,
  params: { was_paid?: boolean; was_shipped?: boolean; limit?: number; offset?: number }
): Promise<EtsyReceipt[]> {
  const { ETSY_SHOP_ID } = getSettings();
  const qs = new URLSearchParams();
  if (params.was_paid !== undefined) qs.set("was_paid", String(params.was_paid));
  if (params.was_shipped !== undefined) qs.set("was_shipped", String(params.was_shipped));
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.offset !== undefined) qs.set("offset", String(params.offset));

  const data = await etsyFetch(
    db,
    `/application/shops/${ETSY_SHOP_ID}/receipts?${qs.toString()}`
  );
  const ListResponseSchema = z.object({ results: z.array(EtsyReceiptSchema) });
  return ListResponseSchema.parse(data).results;
}

export async function submitTracking(
  db: Db,
  receiptId: string | number,
  opts: { tracking_code: string; carrier_name: string; send_bcc?: boolean }
): Promise<void> {
  const { ETSY_SHOP_ID } = getSettings();
  await etsyFetch(db, `/application/shops/${ETSY_SHOP_ID}/receipts/${receiptId}/tracking`, {
    method: "POST",
    body: JSON.stringify(opts),
  });
}

// ── Listing wrappers ───────────────────────────────────────────────────────────

export const EtsyListingCreateInputSchema = z.object({
  taxonomy_id: z.number().int(),
  who_made: z.enum(["i_did", "someone_else", "collective"]),
  when_made: z.string(),
  is_supply: z.boolean(),
  shipping_profile_id: z.number().int(),
  title: z.string().max(140),
  description: z.string(),
  price: z.number().positive(),
  tags: z.array(z.string()).max(13),
  // Required by Etsy POD policy. Must be the numeric ID returned when the
  // production partner (Printify) was registered in Etsy Shop Manager.
  // Validated as non-empty by the Listing Agent before this call is made.
  production_partner_ids: z.array(z.number().int().positive()).min(1),
  // Required on all physical listings as of Etsy's Sep 30 2025 Processing Profiles migration.
  // Get the ID by running scripts/get_etsy_readiness_state.ts once per shop.
  readiness_state_id: z.number().int().positive(),
  materials: z.array(z.string()).optional(),
  processing_min: z.number().int().optional(),
  processing_max: z.number().int().optional(),
});

export type EtsyListingCreateInput = z.infer<typeof EtsyListingCreateInputSchema>;

const EtsyListingResponseSchema = z.object({
  listing_id: z.number(),
  state: z.string(),
  title: z.string(),
});

async function etsyMultipartFetch(
  db: Db,
  path: string,
  formData: FormData
): Promise<unknown> {
  const { ETSY_API_KEY, ETSY_API_SECRET } = getSettings();

  // Mock mode short-circuit. Multipart calls are image uploads; the dispatcher
  // returns a canned listing-image response keyed off the path's listing_id.
  if (isMockMode()) {
    return limiter.schedule(async () => mockEtsyResponse("POST", path, undefined));
  }

  return limiter.schedule(() =>
    retry(
      async (bail) => {
        const token = await getValidAccessToken(db);
        const res = await fetch(`https://openapi.etsy.com/v3${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            // This Etsy app requires the combined "keystring:shared_secret"
            // form in x-api-key; the keystring alone returns
            // "Shared secret is required in x-api-key header." OAuth (etsy-auth.ts)
            // still uses ETSY_API_KEY alone as the client_id.
            "x-api-key": `${ETSY_API_KEY}:${ETSY_API_SECRET}`,
          },
          body: formData,
        });

        if (!res.ok) {
          const body = await res.text();
          if (res.status !== 429 && res.status < 500) {
            bail(new EtsyApiError(`Etsy ${res.status}: ${body}`, res.status));
            return;
          }
          if (res.status === 429) {
            const waitMs = parseRetryAfter(res.headers.get("Retry-After"));
            if (waitMs !== null) {
              await new Promise((r) => setTimeout(r, waitMs));
            }
          }
          throw new EtsyApiError(`Etsy ${res.status}: ${body}`, res.status);
        }

        return res.json();
      },
      { retries: 3, factor: 2, minTimeout: 500 }
    )
  );
}

export async function createDraftListing(
  db: Db,
  input: EtsyListingCreateInput
): Promise<{ listing_id: number }> {
  const { ETSY_SHOP_ID } = getSettings();
  const validated = EtsyListingCreateInputSchema.parse(input);
  const data = await etsyFetch(db, `/application/shops/${ETSY_SHOP_ID}/listings`, {
    method: "POST",
    body: JSON.stringify(validated),
  });
  return EtsyListingResponseSchema.parse(data);
}

export async function uploadListingImage(
  db: Db,
  listingId: number,
  imageUrl: string,
  opts: { timeoutMs?: number; maxBytes?: number; altText?: string; rank?: number } = {}
): Promise<void> {
  const { ETSY_SHOP_ID } = getSettings();
  const timeoutMs = opts.timeoutMs ?? ETSY_IMAGE_DOWNLOAD_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? ETSY_IMAGE_MAX_BYTES;
  const rank = opts.rank ?? 1;
  // Etsy caps alt_text at 250 chars. We truncate rather than reject so a
  // long copy.title doesn't fail the whole publish over an accessibility nicety.
  const altText = opts.altText ? opts.altText.slice(0, 250) : undefined;

  // Mock mode: skip the image download entirely. Downloading from Supabase
  // Storage / Printify CDN works fine but it's wasteful when the upload won't
  // touch real Etsy. The mock dispatcher still logs and returns a canned
  // listing-image payload so callers see realistic shape.
  if (isMockMode()) {
    await limiter.schedule(async () =>
      mockEtsyResponse(
        "POST",
        `/application/shops/${ETSY_SHOP_ID}/listings/${listingId}/images`,
        undefined
      )
    );
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let imageBlob: Blob;
  try {
    let imageRes: Response;
    try {
      imageRes = await fetch(imageUrl, { signal: controller.signal });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new EtsyApiError(
          `Image download timed out after ${timeoutMs}ms: ${imageUrl}`
        );
      }
      throw err;
    }

    if (!imageRes.ok) {
      throw new EtsyApiError(`Failed to download image from ${imageUrl}: ${imageRes.status}`);
    }

    const contentType = imageRes.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("image/")) {
      throw new EtsyApiError(
        `Image download from ${imageUrl} returned non-image content-type: ${contentType || "(missing)"}`
      );
    }

    const declaredLen = Number(imageRes.headers.get("content-length"));
    if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
      throw new EtsyApiError(
        `Image at ${imageUrl} exceeds max size: ${declaredLen} > ${maxBytes} bytes`
      );
    }

    // Stream the body so an oversize file (e.g. missing/lying Content-Length)
    // is short-circuited before we buffer the whole thing in memory.
    if (!imageRes.body) {
      throw new EtsyApiError(`Image response has no body: ${imageUrl}`);
    }
    const reader = imageRes.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        if (received > maxBytes) {
          await reader.cancel();
          throw new EtsyApiError(
            `Image at ${imageUrl} exceeds max size while streaming (> ${maxBytes} bytes)`
          );
        }
        chunks.push(value);
      }
    }
    // Cast each chunk to a generic ArrayBufferView; node fetch's reader yields
    // Uint8Array<ArrayBufferLike> but Blob requires Uint8Array<ArrayBuffer>.
    imageBlob = new Blob(chunks as BlobPart[], { type: contentType });
  } finally {
    clearTimeout(timer);
  }

  const form = new FormData();
  form.append("image", imageBlob, "design.png");
  form.append("rank", String(rank));
  if (altText) {
    form.append("alt_text", altText);
  }

  await etsyMultipartFetch(
    db,
    `/application/shops/${ETSY_SHOP_ID}/listings/${listingId}/images`,
    form
  );
}

// Full image shape returned by GET /listings/{id}/images.
// url_570xN is the standard display size; url_fullxfull is the original upload
// (may be absent on older images). alt_text was added in a later API version
// so we default to null to avoid parse failures on legacy listing images.
export const EtsyListingImageSchema = z.object({
  listing_image_id: z.number(),
  rank: z.number().int(),
  url_570xN: z.string().url(),
  url_fullxfull: z.string().url().optional(),
  alt_text: z.string().nullable().optional(),
});

export type EtsyListingImage = z.infer<typeof EtsyListingImageSchema>;

const EtsyListingImagesResponseSchema = z.object({
  count: z.number().int().nonnegative(),
  results: z.array(EtsyListingImageSchema),
});

/**
 * How many images are already attached to an Etsy listing. Used as an
 * idempotency guard on the publish/resume path: image upload (POST) is NOT
 * idempotent — re-POSTing the same mockup appends a duplicate to the carousel.
 * On a retry we skip the ranks Etsy already has rather than re-uploading them.
 */
export async function getListingImageCount(db: Db, listingId: number): Promise<number> {
  const { ETSY_SHOP_ID } = getSettings();
  const data = await etsyFetch(
    db,
    `/application/shops/${ETSY_SHOP_ID}/listings/${listingId}/images`
  );
  return EtsyListingImagesResponseSchema.parse(data).count;
}

/**
 * Returns all images currently attached to an Etsy listing, sorted by rank.
 * Includes listing_image_id, rank, url_570xN, url_fullxfull, and alt_text.
 * Used by the dashboard's "Etsy listing images" panel.
 */
export async function getListingImages(
  db: Db,
  listingId: number
): Promise<EtsyListingImage[]> {
  const { ETSY_SHOP_ID } = getSettings();
  const data = await etsyFetch(
    db,
    `/application/shops/${ETSY_SHOP_ID}/listings/${listingId}/images`
  );
  const { results } = EtsyListingImagesResponseSchema.parse(data);
  return [...results].sort((a, b) => a.rank - b.rank);
}

/**
 * Deletes a single image from an Etsy listing.
 * DELETE /application/shops/{shop_id}/listings/{listing_id}/images/{image_id}
 * Etsy returns 204 No Content on success; etsyFetch accepts that as ok.
 */
export async function deleteListingImage(
  db: Db,
  listingId: number,
  imageId: number
): Promise<void> {
  const { ETSY_SHOP_ID } = getSettings();
  await etsyFetch(
    db,
    `/application/shops/${ETSY_SHOP_ID}/listings/${listingId}/images/${imageId}`,
    { method: "DELETE" }
  );
}

export async function activateListing(
  db: Db,
  listingId: number
): Promise<void> {
  const { ETSY_SHOP_ID } = getSettings();
  const data = await etsyFetch(
    db,
    `/application/shops/${ETSY_SHOP_ID}/listings/${listingId}`,
    {
      method: "PATCH",
      body: JSON.stringify({ state: "active" }),
    }
  );
  EtsyListingResponseSchema.parse(data);
}

// ── Edits to an already-active listing ──────────────────────────────────────────
//
// Etsy v3 has no separate "republish" endpoint — the same PATCH used for
// activation handles in-place metadata updates when the body omits `state`.
// Edits go live on Etsy immediately. This wrapper covers title/description/
// tags edits from the dashboard's CopyEditor "active mode". Price and
// variant changes are NOT in this surface — those are inventory edits and
// belong on updateListingInventory above.

export const EtsyListingUpdateInputSchema = z.object({
  title: z.string().min(1).max(140).optional(),
  description: z.string().min(1).optional(),
  tags: z.array(z.string()).max(13).optional(),
});

export type EtsyListingUpdateInput = z.infer<typeof EtsyListingUpdateInputSchema>;

export async function updateActiveListing(
  db: Db,
  listingId: number,
  updates: EtsyListingUpdateInput
): Promise<void> {
  const { ETSY_SHOP_ID } = getSettings();
  const validated = EtsyListingUpdateInputSchema.parse(updates);
  if (Object.keys(validated).length === 0) {
    // No-op rather than burning an Etsy call. Caller bug — surface as a
    // generic error so it shows up in tests.
    throw new EtsyApiError(
      "updateActiveListing called with no fields to update"
    );
  }
  const data = await etsyFetch(
    db,
    `/application/shops/${ETSY_SHOP_ID}/listings/${listingId}`,
    {
      method: "PATCH",
      body: JSON.stringify(validated),
    }
  );
  // The mock fixture and real Etsy both echo back the listing shape
  // (listing_id, state, title). Don't strict-validate — Etsy occasionally
  // adds fields that EtsyListingResponseSchema doesn't know about.
  if (typeof data !== "object" || data === null) {
    throw new EtsyApiError(
      `updateActiveListing returned non-object response: ${typeof data}`
    );
  }
}

// ── Reading the shop's live listings ────────────────────────────────────────────
//
// Used by the one-time reconcile script (scripts/reconcile_etsy_listings.ts) to
// compare what's genuinely live on Etsy against the local `listings` table after
// the API was switched on. Goes through etsyFetch, so it inherits token refresh,
// the shared limiter, retries, and mock mode.

// Etsy returns price as a money object; the human price is amount / divisor.
const EtsyMoneySchema = z.object({
  amount: z.number(),
  divisor: z.number().positive(),
  currency_code: z.string(),
});

const EtsyActiveListingSchema = z.object({
  listing_id: z.number(),
  title: z.string(),
  // Etsy occasionally returns null for these on sparse listings.
  description: z.string().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  state: z.string(),
  price: EtsyMoneySchema.optional(),
});

const EtsyActiveListingsResponseSchema = z.object({
  count: z.number(),
  results: z.array(EtsyActiveListingSchema),
});

export interface LiveEtsyListing {
  etsyListingId: number;
  title: string;
  description: string | null;
  tags: string[];
  /** Price in its own currency units (amount / divisor). null if Etsy omitted price. */
  price: number | null;
  currency: string | null;
}

const ETSY_LISTINGS_PAGE_SIZE = 100;
// Defensive ceiling so a paging bug can't loop forever against a large shop.
const ETSY_LISTINGS_MAX_PAGES = 50;

/**
 * Fetches every active (live) listing for the configured shop, following Etsy's
 * limit/offset pagination. Returns a normalized, deduped list keyed by
 * etsy_listing_id.
 */
export async function getActiveEtsyListings(db: Db): Promise<LiveEtsyListing[]> {
  const { ETSY_SHOP_ID } = getSettings();
  const byId = new Map<number, LiveEtsyListing>();

  for (let page = 0; page < ETSY_LISTINGS_MAX_PAGES; page++) {
    const offset = page * ETSY_LISTINGS_PAGE_SIZE;
    const data = await etsyFetch(
      db,
      `/application/shops/${ETSY_SHOP_ID}/listings/active?limit=${ETSY_LISTINGS_PAGE_SIZE}&offset=${offset}`
    );
    const { count, results } = EtsyActiveListingsResponseSchema.parse(data);

    for (const r of results) {
      byId.set(r.listing_id, {
        etsyListingId: r.listing_id,
        title: r.title,
        description: r.description ?? null,
        tags: r.tags ?? [],
        price: r.price ? r.price.amount / r.price.divisor : null,
        currency: r.price ? r.price.currency_code : null,
      });
    }

    if (results.length === 0 || offset + results.length >= count) break;
  }

  return [...byId.values()];
}

/** Set a live Etsy listing to inactive (taken off sale). Best-effort — callers
 *  should catch and log rather than hard-failing; a DB status update should
 *  proceed even if Etsy is temporarily unreachable. */
export async function deactivateEtsyListing(db: Db, listingId: number): Promise<void> {
  const { ETSY_SHOP_ID } = getSettings();
  await etsyFetch(db, `/application/shops/${ETSY_SHOP_ID}/listings/${listingId}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "inactive" }),
  });
}

// ── Inventory (variants) ───────────────────────────────────────────────────────
//
// Etsy's PUT /v3/application/listings/{listing_id}/inventory binds variants
// (sizes, colors, etc.) to a draft listing. Each `product` is one purchasable
// SKU; `offerings` carries the price/quantity/enabled flag, `property_values`
// carries the human-readable variation choice.
//
// We use the **custom properties** path (property_name + values) rather than
// Etsy's numeric property_id + value_ids. Reason: numeric IDs vary per
// taxonomy and require an extra GET to /seller-taxonomy/nodes/{id}/properties.
// Custom properties round-trip cleanly for POD listings and are how the native
// Printify ↔ Etsy integration represents Size/Color variations.

const EtsyOfferingSchema = z.object({
  price: z.number().positive(),
  // Etsy rejects quantity=0 on POD listings. Use .positive() (≥1) to catch
  // misconfigured variants before the API call fails.
  quantity: z.number().int().positive(),
  is_enabled: z.boolean(),
});

const EtsyPropertyValueSchema = z.object({
  // Etsy requires a numeric property_id even for CUSTOM variations: 513 for the
  // first custom-variation axis, 514 for the second (see etsy-blueprints.ts →
  // ETSY_CUSTOM_PROPERTY_IDS). Omitting it makes Etsy fail to parse the product
  // and return a misleading `Missing input parameter: [quantity]` 400.
  // Ref: developers.etsy.com third-variation tutorial.
  property_id: z.number().int(),
  property_name: z.string().min(1),
  values: z.array(z.string().min(1)).min(1).max(1),
  // Empty for custom properties — Etsy assigns an internal value ID — but the
  // key must be present in the payload.
  value_ids: z.array(z.number().int()).default([]),
});

const EtsyInventoryProductSchema = z.object({
  // SKU is optional but strongly recommended — used by the Etsy fulfillment
  // tools and the Etsy ↔ Printify integration to match orders to variants.
  sku: z.string().min(1).max(32).optional(),
  property_values: z.array(EtsyPropertyValueSchema),
  offerings: z.array(EtsyOfferingSchema).min(1),
});

export const EtsyInventoryInputSchema = z.object({
  products: z.array(EtsyInventoryProductSchema).min(1),
  // Properties whose price/quantity/sku is shared across all variants. Empty
  // arrays are explicit (Etsy expects the keys present).
  price_on_property: z.array(z.string()).default([]),
  quantity_on_property: z.array(z.string()).default([]),
  sku_on_property: z.array(z.string()).default([]),
});

export type EtsyInventoryInput = z.infer<typeof EtsyInventoryInputSchema>;
export type EtsyInventoryProduct = z.infer<typeof EtsyInventoryProductSchema>;
export type EtsyInventoryOffering = z.infer<typeof EtsyOfferingSchema>;

export async function updateListingInventory(
  db: Db,
  listingId: number,
  input: EtsyInventoryInput
): Promise<void> {
  const validated = EtsyInventoryInputSchema.parse(input);
  await etsyFetch(db, `/application/listings/${listingId}/inventory`, {
    method: "PUT",
    body: JSON.stringify(validated),
  });
}

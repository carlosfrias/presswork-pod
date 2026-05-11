import Bottleneck from "bottleneck";
import retry from "async-retry";
import { z } from "zod";
import type { Db } from "./db.js";
import { getSettings } from "./config.js";
import { getValidAccessToken } from "./etsy-auth.js";
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
  const { ETSY_API_KEY } = getSettings();

  return limiter.schedule(() =>
    retry(
      async (bail) => {
        const token = await getValidAccessToken(db);
        const res = await fetch(`https://openapi.etsy.com/v3${path}`, {
          ...init,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "x-api-key": ETSY_API_KEY,
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
  const { ETSY_API_KEY } = getSettings();

  return limiter.schedule(() =>
    retry(
      async (bail) => {
        const token = await getValidAccessToken(db);
        const res = await fetch(`https://openapi.etsy.com/v3${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "x-api-key": ETSY_API_KEY,
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
  opts: { timeoutMs?: number; maxBytes?: number } = {}
): Promise<void> {
  const { ETSY_SHOP_ID } = getSettings();
  const timeoutMs = opts.timeoutMs ?? ETSY_IMAGE_DOWNLOAD_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? ETSY_IMAGE_MAX_BYTES;

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
  form.append("rank", "1");

  await etsyMultipartFetch(
    db,
    `/application/shops/${ETSY_SHOP_ID}/listings/${listingId}/images`,
    form
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

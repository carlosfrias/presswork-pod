import Bottleneck from "bottleneck";
import retry from "async-retry";
import { z } from "zod";
import type { Db } from "./db.js";
import { getSettings } from "./config.js";
import { getValidAccessToken } from "./etsy-auth.js";

export class EtsyApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "EtsyApiError";
  }
}

// Shared limiter: 10 req/sec across all Etsy API wrappers
const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 100 });

async function etsyFetch(db: Db, path: string, init: RequestInit = {}): Promise<unknown> {
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
          throw new EtsyApiError(`Etsy ${res.status}: ${body}`, res.status);
        }

        return res.json();
      },
      { retries: 3, factor: 2, minTimeout: 500 }
    )
  );
}

// ── Receipt schemas ────────────────────────────────────────────────────────────

const ReceiptLineItemSchema = z.object({
  listing_id: z.number(),
  quantity: z.number().int(),
  price: z.object({ amount: z.number(), divisor: z.number(), currency_code: z.string() }),
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
  imageUrl: string
): Promise<void> {
  const { ETSY_SHOP_ID } = getSettings();
  const imageRes = await fetch(imageUrl);
  if (!imageRes.ok) {
    throw new EtsyApiError(`Failed to download image from ${imageUrl}: ${imageRes.status}`);
  }
  const imageBlob = await imageRes.blob();

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

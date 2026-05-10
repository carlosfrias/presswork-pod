/**
 * E2E smoke test: seeds trend_brief + design_package (representing Scout + Design output),
 * then drives Listing and Fulfillment with MSW-mocked external HTTP.
 *
 * Requires: INTEGRATION=1, local Supabase running (supabase start).
 *
 * Note: Scout and Design Python agents are tested via packages/scout and
 * packages/design integration tests. This e2e test validates the TS-side
 * handoff chain: Listing publish → Fulfillment webhook.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import request from "supertest";
import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const RUN = process.env["INTEGRATION"] === "1";
const describeIf = RUN ? describe : describe.skip;

const SHOP_ID = process.env["ETSY_SHOP_ID"] ?? "99";
const PRODUCT_ID = "e2e-printify-product-1";
const ETSY_LISTING_ID = 777001;
const RECEIPT_ID = "e2e-receipt-001";
const SECRET = process.env["ETSY_API_SECRET"] ?? "test-secret";

const VALID_COPY = {
  title: "E2E Test Cat Tee",
  description: [
    "A great shirt for cat lovers.",
    "This design was created using AI image generation tools.",
    "Perfect for any cat person.",
  ].join(" "),
  tags: ["cat shirt", "cat tee", "funny cat", "cat lover", "unisex",
         "graphic tee", "cat mom", "cat dad", "pet lover", "animal",
         "cute cat", "cat design", "novelty"],
};

const server = setupServer();

describeIf("E2E: full pipeline smoke test", () => {
  let supabase: ReturnType<typeof createClient>;
  let trendBriefId: string;
  let designPackageId: string;
  let listingId: string;
  let orderId: string | undefined;

  beforeAll(async () => {
    supabase = createClient(
      process.env["SUPABASE_URL"]!,
      process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
      { auth: { persistSession: false } }
    );
    server.listen({ onUnhandledRequest: "warn" });
    Object.assign(process.env, { HUMAN_REVIEW_ENABLED: "false" });

    // ── Step 1: Seed Scout output (trend_brief) ───────────────────────────────
    const { data: tb } = await supabase
      .from("trend_briefs")
      .insert({
        niche: "e2e-test-niche",
        status: "done",
        style_keywords: ["minimalist", "bold"],
        top_tags: ["cat shirt", "cat tee"],
        price_target_usd: 24.99,
        color_palette: ["black", "white"],
      })
      .select("id")
      .single();
    trendBriefId = (tb as { id: string }).id;

    // ── Step 2: Seed Design output (design_package) ───────────────────────────
    const { data: dp } = await supabase
      .from("design_packages")
      .insert({
        trend_brief_id: trendBriefId,
        status: "done",
        image_url: "https://cdn.supabase.co/designs/e2e-test.png",
        printify_blueprint_id: 145,
        printify_variant_ids: [38163, 38177],
        fal_prompt: "print on demand design, transparent background, high resolution, vector-style cat",
      })
      .select("id")
      .single();
    designPackageId = (dp as { id: string }).id;
  });

  afterAll(async () => {
    server.close();
    if (orderId) await supabase.from("orders").delete().eq("id", orderId);
    if (listingId) await supabase.from("listings").delete().eq("id", listingId);
    await supabase.from("design_packages").delete().eq("id", designPackageId);
    await supabase.from("trend_briefs").delete().eq("id", trendBriefId);
  });

  afterEach(() => {
    server.resetHandlers();
    vi.resetModules();
  });

  it("Step 1+2 verified: trend_brief and design_package seeded in DB", async () => {
    const { data: tb } = await supabase
      .from("trend_briefs")
      .select("niche, status")
      .eq("id", trendBriefId)
      .single();
    expect((tb as { niche: string; status: string }).niche).toBe("e2e-test-niche");
    expect((tb as { niche: string; status: string }).status).toBe("done");

    const { data: dp } = await supabase
      .from("design_packages")
      .select("status, image_url")
      .eq("id", designPackageId)
      .single();
    expect((dp as { status: string; image_url: string }).status).toBe("done");
    expect((dp as { status: string; image_url: string }).image_url).toBeTruthy();
  });

  it("Step 3: Listing publishes to active via publishOne", async () => {
    server.use(
      // Anthropic — listing copywriter
      http.post("https://api.anthropic.com/v1/messages", () =>
        HttpResponse.json({
          content: [{ type: "text", text: JSON.stringify(VALID_COPY) }],
        })
      ),
      // Printify — create product
      http.post(`https://api.printify.com/v1/shops/*/products.json`, () =>
        HttpResponse.json({
          id: PRODUCT_ID,
          images: [
            { src: "https://printify.com/e2e-mockup1.jpg" },
            { src: "https://printify.com/e2e-mockup2.jpg" },
          ],
        })
      ),
      // Printify — set visible
      http.post(
        `https://api.printify.com/v1/shops/*/products/${PRODUCT_ID}/publish.json`,
        () => HttpResponse.json({ ok: true })
      ),
      // Etsy token refresh
      http.post("https://api.etsy.com/v3/public/oauth/token", () =>
        HttpResponse.json({
          access_token: "e2e-token",
          refresh_token: "e2e-refresh",
          expires_in: 3600,
        })
      ),
      // Etsy — create draft listing
      http.post(`https://openapi.etsy.com/v3/application/shops/${SHOP_ID}/listings`, () =>
        HttpResponse.json({
          listing_id: ETSY_LISTING_ID,
          state: "draft",
          title: VALID_COPY.title,
        })
      ),
      // Printify mockup image download (for uploadListingImage)
      http.get("https://printify.com/:path*", () =>
        new HttpResponse(new Uint8Array([137, 80, 78, 71]).buffer, {
          headers: { "Content-Type": "image/png" },
        })
      ),
      // Etsy — upload listing image
      http.post(
        `https://openapi.etsy.com/v3/application/shops/${SHOP_ID}/listings/${ETSY_LISTING_ID}/images`,
        () => new HttpResponse(null, { status: 201 })
      ),
      // Etsy — activate listing
      http.patch(
        `https://openapi.etsy.com/v3/application/shops/${SHOP_ID}/listings/${ETSY_LISTING_ID}`,
        () =>
          HttpResponse.json({
            listing_id: ETSY_LISTING_ID,
            state: "active",
            title: VALID_COPY.title,
          })
      )
    );

    const { data: dpRow } = await supabase
      .from("design_packages")
      .select("*")
      .eq("id", designPackageId)
      .single();
    const { data: tbRow } = await supabase
      .from("trend_briefs")
      .select("*")
      .eq("id", trendBriefId)
      .single();

    const { publishOne } = await import("../../packages/listing/src/publisher.js");
    const result = await publishOne(
      supabase,
      dpRow as never,
      { ...(tbRow as object), price_target_usd: 24.99, retry_count: 0 } as never
    );
    listingId = result.listingId;

    const { data: listing } = await supabase
      .from("listings")
      .select("*")
      .eq("id", listingId)
      .single();
    const l = listing as Record<string, unknown>;
    expect(l?.["status"]).toBe("active");
    expect(l?.["is_active"]).toBe(true);
    expect(l?.["etsy_listing_id"]).toBe(ETSY_LISTING_ID);
    expect(l?.["printify_product_id"]).toBe(PRODUCT_ID);

    const { data: dpUpdated } = await supabase
      .from("design_packages")
      .select("mockup_urls")
      .eq("id", designPackageId)
      .single();
    expect((dpUpdated as { mockup_urls: string[] }).mockup_urls).toHaveLength(2);
  });

  it("Step 4: Fulfillment processes Etsy webhook → order reaches submitted", async () => {
    server.use(
      http.get(
        `https://openapi.etsy.com/v3/application/shops/${SHOP_ID}/receipts/${RECEIPT_ID}`,
        () =>
          HttpResponse.json({
            receipt_id: 1,
            buyer_user_id: 1,
            buyer_email: "e2e-buyer@example.com",
            name: "E2E Buyer",
            first_line: "1 Test Ave",
            city: "Portland",
            state: "OR",
            zip: "97201",
            country_iso: "US",
            grandtotal: { amount: 2499, divisor: 100, currency_code: "USD" },
            transactions: [
              {
                listing_id: ETSY_LISTING_ID,
                quantity: 1,
                price: { amount: 2499, divisor: 100, currency_code: "USD" },
              },
            ],
          })
      ),
      http.post("https://api.printify.com/v1/shops/*/orders.json", () =>
        HttpResponse.json({ id: "e2e-pf-order-001" })
      ),
      http.post("https://api.etsy.com/v3/public/oauth/token", () =>
        HttpResponse.json({
          access_token: "e2e-token",
          refresh_token: "e2e-refresh",
          expires_in: 3600,
        })
      )
    );

    const { createApp } = await import("../../packages/fulfillment/src/server.js");
    const { processOrder } = await import("../../packages/fulfillment/src/order-processor.js");
    const app = createApp({ db: supabase, processOrder });

    const payload = Buffer.from(JSON.stringify({ receipt_id: RECEIPT_ID }));
    const sig = createHmac("sha256", SECRET).update(payload).digest("hex");
    const ts = String(Math.floor(Date.now() / 1000));

    const res = await request(app)
      .post("/webhook/etsy-order")
      .set("content-type", "application/octet-stream")
      .set("x-etsy-signature", sig)
      .set("x-etsy-request-timestamp", ts)
      .send(payload);

    expect(res.status).toBe(200);

    const { data: order } = await supabase
      .from("orders")
      .select("*")
      .eq("etsy_order_id", RECEIPT_ID)
      .single();

    expect(order).toBeDefined();
    const o = order as Record<string, unknown>;
    orderId = o?.["id"] as string;
    expect(o?.["status"]).toBe("submitted");
    expect(o?.["printify_order_id"]).toBe("e2e-pf-order-001");
  });
});

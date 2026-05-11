import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import request from "supertest";
import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

// Gated: only run when INTEGRATION=1 is set
const RUN = process.env["INTEGRATION"] === "1";
const describeIf = RUN ? describe : describe.skip;

const server = setupServer();

// Production verifier uses Svix-style headers + base64-decoded secret. Tests
// must mirror that exactly or the entire integration suite is non-functional
// (it was previously signing with the legacy x-etsy-* scheme).
function svixSign(secret: string, id: string, ts: string, body: Buffer): string {
  const decoded = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", decoded)
    .update(`${id}.${ts}.${body.toString("utf8")}`)
    .digest("base64");
  return `v1,${sig}`;
}

describeIf("webhook flow integration", () => {
  let supabase: ReturnType<typeof createClient>;

  let trendBriefId: string;
  let designPackageId: string;
  let listingId: string;
  const ETSY_LISTING_ID = 999000001;
  const RECEIPT_ID = "integration-receipt-1";
  // ETSY_WEBHOOK_SECRET in .env should be prefixed with whsec_; fall back to a
  // deterministic test value when running against the local stack without one.
  const SECRET =
    process.env["ETSY_WEBHOOK_SECRET"] ?? "whsec_ZXRzeS13ZWJob29rLXNlY3JldA==";
  const MSG_ID = "msg_integration_001";

  beforeAll(async () => {
    supabase = createClient(
      process.env["SUPABASE_URL"]!,
      process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
      { auth: { persistSession: false } }
    );
    server.listen({ onUnhandledRequest: "error" });

    // Insert test fixtures
    const { data: tb } = await supabase
      .from("trend_briefs")
      .insert({ niche: "integration-test", status: "done" })
      .select("id")
      .single();
    trendBriefId = (tb as { id: string }).id;

    const { data: dp } = await supabase
      .from("design_packages")
      .insert({
        trend_brief_id: trendBriefId,
        status: "done",
        image_url: "https://cdn.example.com/design.png",
        printify_blueprint_id: 6,
        printify_variant_ids: [101],
      })
      .select("id")
      .single();
    designPackageId = (dp as { id: string }).id;

    const { data: ls } = await supabase
      .from("listings")
      .insert({
        design_package_id: designPackageId,
        status: "active",
        etsy_listing_id: ETSY_LISTING_ID,
        title: "Integration Test Shirt",
        price_usd: 24.99,
        is_active: true,
      })
      .select("id")
      .single();
    listingId = (ls as { id: string }).id;
  });

  afterAll(async () => {
    server.close();
    // Clean up in reverse foreign-key order
    await supabase.from("orders").delete().eq("etsy_order_id", RECEIPT_ID);
    await supabase.from("listings").delete().eq("id", listingId);
    await supabase.from("design_packages").delete().eq("id", designPackageId);
    await supabase.from("trend_briefs").delete().eq("id", trendBriefId);
  });

  it("valid signed webhook → 200, orders row created at submitted with economics", async () => {
    server.use(
      http.get(
        `https://openapi.etsy.com/v3/application/shops/*/receipts/${RECEIPT_ID}`,
        () =>
          HttpResponse.json({
            // Etsy sends receipt_id as a number; production code coerces to
            // string for DB lookups. Fixture must mirror Etsy's actual type.
            receipt_id: 1,
            buyer_user_id: 1,
            buyer_email: "test@example.com",
            name: "Test Buyer",
            first_line: "123 Test St",
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
        HttpResponse.json({ id: "pf-integration-001" })
      ),
      http.post("https://api.etsy.com/v3/public/oauth/token", () =>
        HttpResponse.json({
          access_token: "fresh-token",
          refresh_token: "fresh-refresh",
          expires_in: 3600,
        })
      )
    );

    const { createApp } = await import("../../src/server.js");
    const { processOrder } = await import("../../src/order-processor.js");
    const app = createApp({ db: supabase, processOrder });

    const payload = Buffer.from(JSON.stringify({ receipt_id: RECEIPT_ID }));
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = svixSign(SECRET, MSG_ID, ts, payload);

    const res = await request(app)
      .post("/webhook/etsy-order")
      .set("content-type", "application/octet-stream")
      .set("webhook-id", MSG_ID)
      .set("webhook-timestamp", ts)
      .set("webhook-signature", sig)
      .send(payload);

    expect(res.status).toBe(200);

    const { data: order } = await supabase
      .from("orders")
      .select("*")
      .eq("etsy_order_id", RECEIPT_ID)
      .single();

    expect(order).toBeDefined();
    const o = order as Record<string, unknown>;
    expect(o?.["status"]).toBe("submitted");
    expect(o?.["printify_order_id"]).toBe("pf-integration-001");
    expect(Number(o?.["etsy_fees_usd"])).toBeGreaterThan(0);
    expect(Number(o?.["print_cost_usd"])).toBe(8.5);
  });

  it("replay: same receipt POSTed again → 200, still only one orders row", async () => {
    server.use(
      http.get(`https://openapi.etsy.com/v3/application/shops/*/receipts/${RECEIPT_ID}`, () =>
        HttpResponse.json({
          receipt_id: 1,
          buyer_user_id: 1,
          name: "Test Buyer",
          first_line: "123 Test St",
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
      )
    );

    const { createApp } = await import("../../src/server.js");
    const { processOrder } = await import("../../src/order-processor.js");
    const app = createApp({ db: supabase, processOrder });

    const payload = Buffer.from(JSON.stringify({ receipt_id: RECEIPT_ID }));
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = svixSign(SECRET, MSG_ID, ts, payload);

    const res = await request(app)
      .post("/webhook/etsy-order")
      .set("content-type", "application/octet-stream")
      .set("webhook-id", MSG_ID)
      .set("webhook-timestamp", ts)
      .set("webhook-signature", sig)
      .send(payload);

    expect(res.status).toBe(200);

    const { data: rows } = await supabase
      .from("orders")
      .select("id")
      .eq("etsy_order_id", RECEIPT_ID);
    expect((rows as unknown[]).length).toBe(1);
  });

  it("bad HMAC → 401, no orders row inserted for bad-receipt-id", async () => {
    const { createApp } = await import("../../src/server.js");
    const { processOrder } = await import("../../src/order-processor.js");
    const app = createApp({ db: supabase, processOrder });

    const payload = Buffer.from(JSON.stringify({ receipt_id: "bad-receipt-999" }));
    const ts = String(Math.floor(Date.now() / 1000));

    const res = await request(app)
      .post("/webhook/etsy-order")
      .set("content-type", "application/octet-stream")
      .set("webhook-id", MSG_ID)
      .set("webhook-timestamp", ts)
      .set("webhook-signature", "v1,badsignature")
      .send(payload);

    expect(res.status).toBe(401);

    const { data: rows } = await supabase
      .from("orders")
      .select("id")
      .eq("etsy_order_id", "bad-receipt-999");
    expect((rows as unknown[]).length).toBe(0);
  });
});

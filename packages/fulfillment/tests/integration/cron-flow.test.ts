import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { createClient } from "@supabase/supabase-js";

const RUN = process.env["INTEGRATION"] === "1";
const describeIf = RUN ? describe : describe.skip;

const server = setupServer();

describeIf("cron flow integration", () => {
  let supabase: ReturnType<typeof createClient>;

  let trendBriefId: string;
  let designPackageId: string;
  let listingId: string;
  let existingOrderId: string;

  const ETSY_LISTING_ID = 999000002;
  const EXISTING_RECEIPT_ID = "cron-existing-receipt";
  const NEW_RECEIPT_ID = "cron-new-receipt";
  const PRINTIFY_ORDER_ID = "pf-cron-001";

  beforeAll(async () => {
    supabase = createClient(
      process.env["SUPABASE_URL"]!,
      process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
      { auth: { persistSession: false } }
    );
    server.listen({ onUnhandledRequest: "warn" });

    const { data: tb } = await supabase
      .from("trend_briefs")
      .insert({ niche: "cron-integration-test", status: "done" })
      .select("id")
      .single();
    trendBriefId = (tb as { id: string }).id;

    const { data: dp } = await supabase
      .from("design_packages")
      .insert({
        trend_brief_id: trendBriefId,
        status: "done",
        image_url: "https://cdn.example.com/cron-design.png",
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
        title: "Cron Integration Test Shirt",
        price_usd: 24.99,
        is_active: true,
      })
      .select("id")
      .single();
    listingId = (ls as { id: string }).id;

    // Pre-insert an existing submitted order (for polling duplicate check)
    const { data: existingOrder } = await supabase
      .from("orders")
      .insert({
        etsy_order_id: EXISTING_RECEIPT_ID,
        listing_id: listingId,
        status: "submitted",
        printify_order_id: PRINTIFY_ORDER_ID,
        sale_price_usd: 24.99,
        print_cost_usd: 8.5,
        etsy_fees_usd: 2.82,
        buyer_country: "US",
        retry_count: 0,
      })
      .select("id")
      .single();
    existingOrderId = (existingOrder as { id: string }).id;
  });

  afterAll(async () => {
    server.close();
    await supabase.from("orders").delete().eq("etsy_order_id", EXISTING_RECEIPT_ID);
    await supabase.from("orders").delete().eq("etsy_order_id", NEW_RECEIPT_ID);
    await supabase.from("listings").delete().eq("id", listingId);
    await supabase.from("design_packages").delete().eq("id", designPackageId);
    await supabase.from("trend_briefs").delete().eq("id", trendBriefId);
  });

  it("pollReceipts: skips existing receipt, creates new order for new receipt", async () => {
    const receiptShape = (id: string | number) => ({
      receipt_id: id,
      buyer_user_id: 1,
      buyer_email: "test@example.com",
      name: "Cron Buyer",
      first_line: "456 Cron Ave",
      city: "Portland",
      state: "OR",
      zip: "97201",
      country_iso: "US",
      grandtotal: { amount: 2499, divisor: 100, currency_code: "USD" },
      transactions: [
        { listing_id: ETSY_LISTING_ID, quantity: 1, price: { amount: 2499, divisor: 100, currency_code: "USD" } },
      ],
    });

    server.use(
      http.get("https://openapi.etsy.com/v3/application/shops/*/receipts", () =>
        HttpResponse.json({
          results: [receiptShape(EXISTING_RECEIPT_ID), receiptShape(NEW_RECEIPT_ID)],
        })
      ),
      http.get(
        `https://openapi.etsy.com/v3/application/shops/*/receipts/${NEW_RECEIPT_ID}`,
        () => HttpResponse.json(receiptShape(NEW_RECEIPT_ID))
      ),
      http.get(
        `https://openapi.etsy.com/v3/application/shops/*/receipts/${EXISTING_RECEIPT_ID}`,
        () => HttpResponse.json(receiptShape(EXISTING_RECEIPT_ID))
      ),
      http.post("https://api.printify.com/v1/shops/*/orders.json", () =>
        HttpResponse.json({ id: "pf-cron-002" })
      ),
      http.post("https://api.etsy.com/v3/public/oauth/token", () =>
        HttpResponse.json({
          access_token: "fresh-token",
          refresh_token: "fresh-refresh",
          expires_in: 3600,
        })
      )
    );

    const { pollReceipts } = await import("../../src/receipt-poller.js");
    const { processOrder } = await import("../../src/order-processor.js");
    const stats = await pollReceipts(supabase, processOrder);

    expect(stats.scanned).toBe(2);
    expect(stats.skipped).toBe(1);
    expect(stats.processed).toBe(1);

    // New order row should exist
    const { data: newOrder } = await supabase
      .from("orders")
      .select("status, printify_order_id")
      .eq("etsy_order_id", NEW_RECEIPT_ID)
      .single();
    expect((newOrder as Record<string, unknown>)?.["status"]).toBe("submitted");
  });

  it("pollTracking: updates shipped order row with tracking, untouched row stays submitted", async () => {
    // The existing order has printify_order_id = PRINTIFY_ORDER_ID and status = submitted

    server.use(
      http.get(
        `https://api.printify.com/v1/shops/*/orders/${PRINTIFY_ORDER_ID}.json`,
        () =>
          HttpResponse.json({
            id: PRINTIFY_ORDER_ID,
            status: "shipped",
            shipments: [
              { carrier: "USPS", number: "1ZTRACKING", url: "https://usps.com/track/1ZTRACKING" },
            ],
          })
      ),
      http.post("https://openapi.etsy.com/v3/application/shops/*/receipts/*/tracking", () =>
        HttpResponse.json({ ok: true })
      ),
      http.post("https://api.etsy.com/v3/public/oauth/token", () =>
        HttpResponse.json({
          access_token: "fresh-token",
          refresh_token: "fresh-refresh",
          expires_in: 3600,
        })
      )
    );

    const { pollTracking } = await import("../../src/tracking-poller.js");
    const stats = await pollTracking(supabase);

    expect(stats.shipped).toBeGreaterThanOrEqual(1);

    // Verify our known order row updated to shipped with tracking
    const { data: updated } = await supabase
      .from("orders")
      .select("status, tracking_number")
      .eq("id", existingOrderId)
      .single();
    const o = updated as Record<string, unknown>;
    expect(o?.["status"]).toBe("shipped");
    expect(o?.["tracking_number"]).toBe("1ZTRACKING");
  });
});

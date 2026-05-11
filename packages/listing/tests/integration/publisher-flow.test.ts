/**
 * Integration test for the full listing publish flow.
 * Requires: INTEGRATION=1, local Supabase running (supabase start).
 * All external HTTP is mocked with MSW.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { createClient } from "@supabase/supabase-js";
import { AI_DISCLOSURE_TEXT } from "@presswork/shared";

const RUN = process.env["INTEGRATION"] === "1";
const describeIf = RUN ? describe : describe.skip;

const SHOP_ID = process.env["ETSY_SHOP_ID"] ?? "99";
const PRODUCT_ID = "printify-integration-product-1";
const ETSY_LISTING_ID = 888001;

// Etsy compliance: production_partner_ids field is required on every listing.
// The integration env must provide a numeric ID; tests inject a fake one.
process.env["ETSY_PRODUCTION_PARTNER_ID"] =
  process.env["ETSY_PRODUCTION_PARTNER_ID"] ?? "999001";

const VALID_COPY = {
  title: "Cat Tee for Cat Lovers Soft Cotton Crewneck",
  description: [
    "A great shirt for cat lovers.",
    AI_DISCLOSURE_TEXT,
    "Perfect gift for any occasion.",
  ].join(" "),
  tags: ["cat shirt", "cat tee", "funny cat", "cat lover", "unisex",
         "graphic tee", "cat mom", "cat dad", "pet lover", "animal",
         "cute cat", "cat design", "novelty"],
};

const server = setupServer();

// Base MSW handlers for all external services. Paths and verbs must mirror
// production exactly — see packages/listing/src/printify.ts and
// packages/shared/src/etsy-api.ts for the source of truth.
function baseHandlers(activateFails = false) {
  return [
    // Anthropic — returns valid listing copy JSON
    http.post("https://api.anthropic.com/v1/messages", () =>
      HttpResponse.json({
        content: [{ type: "text", text: JSON.stringify(VALID_COPY) }],
      })
    ),
    // Printify — register image into media library (createHiddenProduct's first
    // step). Production code calls this BEFORE products.json and expects an id
    // back to put into print_areas[].placeholders[].images[].id.
    http.post("https://api.printify.com/v1/uploads/images.json", () =>
      HttpResponse.json({ id: "upload-id-1" })
    ),
    // Printify — create product. Response shape matches the new Step 5 schema
    // (variants[] + options[]) so extractVariantOptions can map size/color
    // back to variant_ids on the fulfillment side.
    http.post(`https://api.printify.com/v1/shops/*/products.json`, () =>
      HttpResponse.json({
        id: PRODUCT_ID,
        images: [
          { src: "https://printify.com/mockup1.jpg" },
          { src: "https://printify.com/mockup2.jpg" },
        ],
        variants: [
          { id: 38163, title: "S / Black", options: [101, 201] },
          { id: 38177, title: "M / Black", options: [102, 201] },
        ],
        options: [
          {
            name: "Size",
            type: "size",
            values: [
              { id: 101, title: "S" },
              { id: 102, title: "M" },
            ],
          },
          { name: "Color", type: "color", values: [{ id: 201, title: "Black" }] },
        ],
      })
    ),
    // Printify — set visible. setProductVisible uses PUT to products/{id}.json
    // with { is_visible: true } — NOT a /publish.json POST.
    http.put(
      `https://api.printify.com/v1/shops/*/products/${PRODUCT_ID}.json`,
      () => HttpResponse.json({ ok: true })
    ),
    // Etsy token refresh
    http.post("https://api.etsy.com/v3/public/oauth/token", () =>
      HttpResponse.json({ access_token: "test-token", refresh_token: "test-refresh", expires_in: 3600 })
    ),
    // Etsy — create draft listing
    http.post(`https://openapi.etsy.com/v3/application/shops/${SHOP_ID}/listings`, () =>
      HttpResponse.json({ listing_id: ETSY_LISTING_ID, state: "draft", title: VALID_COPY.title })
    ),
    // Etsy — upload image (stub the image download too)
    http.get("https://printify.com/:path*", () =>
      new HttpResponse(new Uint8Array([137, 80, 78, 71]).buffer, {
        headers: { "Content-Type": "image/png" },
      })
    ),
    http.post(
      `https://openapi.etsy.com/v3/application/shops/${SHOP_ID}/listings/${ETSY_LISTING_ID}/images`,
      () => HttpResponse.json({ listing_image_id: 1, rank: 1 }, { status: 201 })
    ),
    // Etsy — activate listing
    http.patch(
      `https://openapi.etsy.com/v3/application/shops/${SHOP_ID}/listings/${ETSY_LISTING_ID}`,
      () => {
        if (activateFails) {
          return new HttpResponse("server error", { status: 500 });
        }
        return HttpResponse.json({ listing_id: ETSY_LISTING_ID, state: "active", title: VALID_COPY.title });
      }
    ),
  ];
}

describeIf("listing publisher integration", () => {
  let supabase: ReturnType<typeof createClient>;
  let trendBriefId: string;
  let designPackageId: string;
  const insertedListingIds: string[] = [];

  beforeAll(async () => {
    supabase = createClient(
      process.env["SUPABASE_URL"]!,
      process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
      { auth: { persistSession: false } }
    );
    server.listen({ onUnhandledRequest: "warn" });

    // Seed trend_brief + design_package
    const { data: tb } = await supabase
      .from("trend_briefs")
      .insert({ niche: "listing-integration-test", status: "done" })
      .select("id")
      .single();
    trendBriefId = (tb as { id: string }).id;

    const { data: dp } = await supabase
      .from("design_packages")
      .insert({
        trend_brief_id: trendBriefId,
        status: "done",
        image_url: "https://cdn.supabase.co/designs/test.png",
        printify_blueprint_id: 145,
        printify_variant_ids: [38163, 38177],
        fal_prompt: "test prompt",
      })
      .select("id")
      .single();
    designPackageId = (dp as { id: string }).id;
  });

  afterAll(async () => {
    server.close();
    // Clean up in reverse FK order
    for (const lid of insertedListingIds) {
      await supabase.from("listings").delete().eq("id", lid);
    }
    await supabase.from("design_packages").delete().eq("id", designPackageId);
    await supabase.from("trend_briefs").delete().eq("id", trendBriefId);
  });

  afterEach(() => {
    server.resetHandlers();
    vi.resetModules();
  });

  it("happy path (HUMAN_REVIEW=false): listing reaches active with all fields set", async () => {
    server.use(...baseHandlers(false));
    Object.assign(process.env, { HUMAN_REVIEW_ENABLED: "false" });

    const design = await supabase
      .from("design_packages")
      .select("*")
      .eq("id", designPackageId)
      .single();
    const brief = await supabase
      .from("trend_briefs")
      .select("*")
      .eq("id", trendBriefId)
      .single();

    const { publishOne } = await import("../../src/publisher.js");

    const { listingId } = await publishOne(
      supabase,
      { ...(design.data as object), price_target_usd: 24.99 } as never,
      { ...(brief.data as object), price_target_usd: 24.99, retry_count: 0 } as never
    );
    insertedListingIds.push(listingId);

    const { data: listing } = await supabase
      .from("listings")
      .select("*")
      .eq("id", listingId)
      .single();

    const row = listing as Record<string, unknown>;
    expect(row?.["status"]).toBe("active");
    expect(row?.["is_active"]).toBe(true);
    expect(row?.["etsy_listing_id"]).toBe(ETSY_LISTING_ID);
    expect(row?.["printify_product_id"]).toBe(PRODUCT_ID);

    const { data: dp } = await supabase
      .from("design_packages")
      .select("mockup_urls, mockups_from_actual_design")
      .eq("id", designPackageId)
      .single();
    const dpRow = dp as { mockup_urls: string[]; mockups_from_actual_design: boolean };
    expect(dpRow.mockup_urls).toHaveLength(2);
    // Compliance rule 4: provenance flag must be flipped true when mockups are written
    expect(dpRow.mockups_from_actual_design).toBe(true);
  });

  it("human review path: pauses at needs_review, then resumePublish completes", async () => {
    server.use(...baseHandlers(false));
    Object.assign(process.env, { HUMAN_REVIEW_ENABLED: "true" });

    const design = await supabase
      .from("design_packages")
      .select("*")
      .eq("id", designPackageId)
      .single();
    const brief = await supabase
      .from("trend_briefs")
      .select("*")
      .eq("id", trendBriefId)
      .single();

    const { publishOne, resumePublish } = await import("../../src/publisher.js");

    const { listingId } = await publishOne(
      supabase,
      design.data as never,
      { ...(brief.data as object), price_target_usd: 24.99, retry_count: 0 } as never
    );
    insertedListingIds.push(listingId);

    const { data: pausedListing } = await supabase
      .from("listings")
      .select("status")
      .eq("id", listingId)
      .single();
    expect((pausedListing as { status: string }).status).toBe("needs_review");

    // Simulate manual approval: flip to pending_publish
    await supabase.from("listings").update({ status: "pending_publish" }).eq("id", listingId);

    Object.assign(process.env, { HUMAN_REVIEW_ENABLED: "false" });
    await resumePublish(supabase, listingId);

    const { data: activeListing } = await supabase
      .from("listings")
      .select("status, is_active, etsy_listing_id")
      .eq("id", listingId)
      .single();
    const active = activeListing as Record<string, unknown>;
    expect(active?.["status"]).toBe("active");
    expect(active?.["is_active"]).toBe(true);
    expect(active?.["etsy_listing_id"]).toBe(ETSY_LISTING_ID);
  });

  it("retryable failure: first publishOne throws, retry via resumePublish succeeds", async () => {
    // activateListing fails the first time
    server.use(...baseHandlers(true));
    Object.assign(process.env, { HUMAN_REVIEW_ENABLED: "false" });

    const design = await supabase
      .from("design_packages")
      .select("*")
      .eq("id", designPackageId)
      .single();
    const brief = await supabase
      .from("trend_briefs")
      .select("*")
      .eq("id", trendBriefId)
      .single();

    const { publishOne, resumePublish } = await import("../../src/publisher.js");

    let listingId: string;
    await expect(
      publishOne(
        supabase,
        design.data as never,
        { ...(brief.data as object), price_target_usd: 24.99, retry_count: 0 } as never
      ).then((r) => { listingId = r.listingId; })
    ).rejects.toThrow();

    // Get the listing that was created before the failure
    const { data: listings } = await supabase
      .from("listings")
      .select("id, status, retry_count")
      .eq("design_package_id", designPackageId)
      .order("created_at", { ascending: false })
      .limit(1);
    const failedListing = (listings as Array<Record<string, unknown>>)[0];
    listingId = failedListing?.["id"] as string;
    insertedListingIds.push(listingId);

    expect(failedListing?.["retry_count"]).toBe(1);
    expect(failedListing?.["status"]).toBe("pending");

    // Flip to pending_publish for resumePublish
    await supabase.from("listings").update({ status: "pending_publish" }).eq("id", listingId);

    // Now retry with activateListing succeeding
    server.resetHandlers();
    server.use(...baseHandlers(false));
    await resumePublish(supabase, listingId);

    const { data: recovered } = await supabase
      .from("listings")
      .select("status")
      .eq("id", listingId)
      .single();
    expect((recovered as { status: string }).status).toBe("active");
  });

  it("exhausted retries: after 3 failures listing reaches error status", async () => {
    server.use(...baseHandlers(true));
    Object.assign(process.env, { HUMAN_REVIEW_ENABLED: "false" });

    const design = await supabase
      .from("design_packages")
      .select("*")
      .eq("id", designPackageId)
      .single();
    const brief = await supabase
      .from("trend_briefs")
      .select("*")
      .eq("id", trendBriefId)
      .single();

    const { publishOne, resumePublish } = await import("../../src/publisher.js");

    // First attempt via publishOne
    let listingId: string;
    await expect(
      publishOne(
        supabase,
        design.data as never,
        { ...(brief.data as object), price_target_usd: 24.99, retry_count: 0 } as never
      ).then((r) => { listingId = r.listingId; })
    ).rejects.toThrow();

    const { data: listings } = await supabase
      .from("listings")
      .select("id")
      .eq("design_package_id", designPackageId)
      .order("created_at", { ascending: false })
      .limit(1);
    listingId = ((listings as Array<Record<string, unknown>>)[0]?.["id"]) as string;
    insertedListingIds.push(listingId);

    // Two more failures via resumePublish
    await supabase.from("listings").update({ status: "pending_publish" }).eq("id", listingId);
    await expect(resumePublish(supabase, listingId)).rejects.toThrow();

    await supabase.from("listings").update({ status: "pending_publish" }).eq("id", listingId);
    await expect(resumePublish(supabase, listingId)).rejects.toThrow();

    const { data: final } = await supabase
      .from("listings")
      .select("status, retry_count")
      .eq("id", listingId)
      .single();
    const f = final as Record<string, unknown>;
    expect(f?.["status"]).toBe("error");
    expect(f?.["retry_count"]).toBe(3);
  });
});

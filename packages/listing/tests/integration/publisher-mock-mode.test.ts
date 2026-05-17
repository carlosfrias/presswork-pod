/**
 * End-to-end run of the listing publisher with ETSY_MOCK_MODE=true.
 *
 * The flag must be set on process.env BEFORE any module that calls
 * getSettings() is imported — config.ts caches the parsed settings on first
 * read. We dynamic-import publisher inside each test so vi.resetModules()
 * in afterEach gives us a fresh shared cache per scenario.
 *
 * Anthropic + Printify are still MSW-mocked here. Only Etsy short-circuits
 * via the mock-mode flag — that's the contract under test.
 *
 * Requires: INTEGRATION=1, local Supabase running.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { createClient } from "@supabase/supabase-js";
import { AI_DISCLOSURE_TEXT } from "@presswork/shared";

const RUN = process.env["INTEGRATION"] === "1";
const describeIf = RUN ? describe : describe.skip;

// Flip mock mode ON before any shared/listing import resolves. Anything that
// imports config indirectly (and reads getSettings) will see this value.
process.env["ETSY_MOCK_MODE"] = "true";
// Real Etsy creds are not needed; placeholders are fine in mock mode. The
// numeric IDs still feed into payload validators so use realistic positive
// integers.
process.env["ETSY_API_KEY"] = process.env["ETSY_API_KEY"] ?? "mock";
process.env["ETSY_API_SECRET"] = process.env["ETSY_API_SECRET"] ?? "mock";
process.env["ETSY_ACCESS_TOKEN"] = process.env["ETSY_ACCESS_TOKEN"] ?? "mock";
process.env["ETSY_REFRESH_TOKEN"] = process.env["ETSY_REFRESH_TOKEN"] ?? "mock";
process.env["ETSY_SHOP_ID"] = process.env["ETSY_SHOP_ID"] ?? "99";
process.env["ETSY_SHIPPING_PROFILE_ID"] =
  process.env["ETSY_SHIPPING_PROFILE_ID"] ?? "1";
process.env["ETSY_PRODUCTION_PARTNER_ID"] =
  process.env["ETSY_PRODUCTION_PARTNER_ID"] ?? "999001";
process.env["ETSY_READINESS_STATE_ID"] =
  process.env["ETSY_READINESS_STATE_ID"] ?? "1";

const PRODUCT_ID = "printify-mockmode-product-1";

const VALID_COPY = {
  title: "Cat Tee for Cat Lovers Soft Cotton Crewneck",
  description: [
    "A great shirt for cat lovers.",
    AI_DISCLOSURE_TEXT,
    "Perfect gift for any occasion.",
  ].join(" "),
  tags: [
    "cat shirt", "cat tee", "funny cat", "cat lover", "unisex",
    "graphic tee", "cat mom", "cat dad", "pet lover", "animal",
    "cute cat", "cat design", "novelty",
  ],
};

// MSW handlers cover everything mock-mode does NOT short-circuit:
// Anthropic (writeCopy) and Printify (product create + visibility flip).
// Etsy endpoints intentionally have NO MSW handler — if mock-mode failed to
// short-circuit, the test would error on an unhandled openapi.etsy.com
// request, making the regression visible.
function nonEtsyHandlers() {
  return [
    http.post("https://api.anthropic.com/v1/messages", () =>
      HttpResponse.json({
        content: [{ type: "text", text: JSON.stringify(VALID_COPY) }],
      })
    ),
    http.post("https://api.printify.com/v1/uploads/images.json", () =>
      HttpResponse.json({ id: "upload-id-mockmode" })
    ),
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
          {
            name: "Color",
            type: "color",
            values: [{ id: 201, title: "Black" }],
          },
        ],
      })
    ),
    http.put(
      `https://api.printify.com/v1/shops/*/products/${PRODUCT_ID}.json`,
      () => HttpResponse.json({ ok: true })
    ),
  ];
}

const server = setupServer();

describeIf("listing publisher — ETSY_MOCK_MODE=true", () => {
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

    const { data: tb } = await supabase
      .from("trend_briefs")
      .insert({ niche: "mockmode-integration-test", status: "done" })
      .select("id")
      .single();
    trendBriefId = (tb as { id: string }).id;

    const { data: dp } = await supabase
      .from("design_packages")
      .insert({
        trend_brief_id: trendBriefId,
        status: "done",
        image_url: "https://cdn.supabase.co/designs/mockmode.png",
        printify_blueprint_id: 145,
        printify_print_provider_id: 3,
        printify_variant_ids: [38163, 38177],
        fal_prompt: "mock-mode test prompt",
      })
      .select("id")
      .single();
    designPackageId = (dp as { id: string }).id;
  });

  afterAll(async () => {
    server.close();
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

  it("publishOne pauses at needs_review, resumePublish lands the listing at active without a single Etsy network call", async () => {
    server.use(...nonEtsyHandlers());

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
      { ...(design.data as object), price_target_usd: 24.99 } as never,
      { ...(brief.data as object), price_target_usd: 24.99, retry_count: 0 } as never
    );
    insertedListingIds.push(listingId);

    const { data: paused } = await supabase
      .from("listings")
      .select("status, printify_product_id")
      .eq("id", listingId)
      .single();
    const pausedRow = paused as Record<string, unknown>;
    expect(pausedRow["status"]).toBe("needs_review");
    expect(pausedRow["printify_product_id"]).toBe(PRODUCT_ID);

    // Compliance rule 4: provenance flag flipped true during Printify create,
    // and printify_variants populated so executeEtsyPublish can build inventory.
    const { data: dp } = await supabase
      .from("design_packages")
      .select("mockup_urls, mockups_from_actual_design, printify_variants")
      .eq("id", designPackageId)
      .single();
    const dpRow = dp as {
      mockup_urls: string[];
      mockups_from_actual_design: boolean;
      printify_variants: Array<{ id: number; values: string[] }>;
    };
    expect(dpRow.mockup_urls.length).toBeGreaterThan(0);
    expect(dpRow.mockups_from_actual_design).toBe(true);
    expect(dpRow.printify_variants.length).toBe(2);

    // Approve → resume publish (this is the Etsy boundary; mock mode handles
    // every Etsy call without MSW handlers and without network).
    await supabase.from("listings").update({ status: "pending_publish" }).eq("id", listingId);
    await resumePublish(supabase, listingId);

    const { data: activeListing } = await supabase
      .from("listings")
      .select("status, is_active, etsy_listing_id")
      .eq("id", listingId)
      .single();
    const active = activeListing as Record<string, unknown>;
    expect(active["status"]).toBe("active");
    expect(active["is_active"]).toBe(true);
    // Mock-mode listing IDs are deterministic from the title; just assert non-null.
    expect(active["etsy_listing_id"]).toBeTypeOf("number");
    expect(active["etsy_listing_id"]).toBeGreaterThan(0);
  });

  it("rejects mock-placeholder OAuth fields when ETSY_MOCK_MODE is off", async () => {
    // Spawn a fresh shared module graph with mock mode OFF. Use a separate
    // env snapshot to avoid leaking back into the other test.
    const original = { ...process.env };
    process.env["ETSY_MOCK_MODE"] = "false";
    process.env["ETSY_API_KEY"] = "mock";
    process.env["ETSY_API_SECRET"] = "mock";
    process.env["ETSY_ACCESS_TOKEN"] = "mock";
    process.env["ETSY_REFRESH_TOKEN"] = "mock";
    vi.resetModules();

    let threw: unknown;
    try {
      const { getSettings } = await import("@presswork/shared");
      getSettings();
    } catch (e) {
      threw = e;
    } finally {
      Object.assign(process.env, original);
      vi.resetModules();
    }

    expect(threw).toBeInstanceOf(Error);
    expect(String((threw as Error).message)).toMatch(/mock placeholder/i);
  });
});

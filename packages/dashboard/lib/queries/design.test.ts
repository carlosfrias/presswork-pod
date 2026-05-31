import { describe, it, expect, vi } from "vitest";
import { makeSupabaseMock, type SupabaseMockOpts } from "@/tests/helpers/supabase-mock";
import { extractRegenStack } from "./design";

async function loadModule(opts: SupabaseMockOpts) {
  const { client, capture } = makeSupabaseMock(opts);
  vi.doMock("@/lib/supabase/server", () => ({ serviceClient: () => client }));
  vi.resetModules();
  const mod = await import("./design");
  return { mod, capture };
}

describe("getDesignReviewQueue", () => {
  it("maps design_packages → trend_brief and narrows the brief's style/model/bg fields", async () => {
    const rows = [
      {
        id: "dp-1",
        status: "needs_review",
        image_url: "https://cdn.test/d1.png",
        metadata: null,
        trend_briefs: {
          id: "tb-1",
          niche: "cats",
          color_palette: ["#ff0000", "#00ff00"],
          claude_analysis: { style: "screen_print" },
          image_model: "fal_gpt_image_2",
          background_removal_mode: "birefnet",
          shirt_colors: null,
          shirt_sizes: null,
          image_description: null,
        },
      },
    ];
    const { mod } = await loadModule({ design_packages: { rows } });

    const queue = await mod.getDesignReviewQueue();

    expect(queue).toHaveLength(1);
    const item = queue[0];
    expect(item.trend_brief).toEqual({
      id: "tb-1",
      niche: "cats",
      color_palette: ["#ff0000", "#00ff00"],
      style: "screen_print",
      image_model: "fal_gpt_image_2",
      background_removal_mode: "birefnet",
      image_description: null,
      shirt_colors: ["White"],
      shirt_sizes: ["S", "M", "L", "XL", "2XL"],
    });
    // regen_stack defaults to [] when metadata is null
    expect(item.regen_stack).toEqual([]);
  });

  it("falls back to a safe default image_model when the stored value is unknown", async () => {
    const rows = [
      {
        id: "dp-1",
        status: "needs_review",
        metadata: null,
        trend_briefs: {
          id: "tb-1",
          niche: "cats",
          color_palette: [],
          claude_analysis: null,
          image_model: "deleted_model_xyz",
          background_removal_mode: null,
        },
      },
    ];
    const { mod } = await loadModule({ design_packages: { rows } });

    const queue = await mod.getDesignReviewQueue();

    expect(queue[0].trend_brief?.image_model).toBe("fal_gpt_image_2");
    expect(queue[0].trend_brief?.style).toBeNull();
    expect(queue[0].trend_brief?.background_removal_mode).toBeNull();
  });

  it("populates regen_stack from metadata.image_versions when present", async () => {
    const rows = [
      {
        id: "dp-1",
        status: "needs_review",
        metadata: {
          image_versions: [
            { kind: "regen", masked_url: "https://cdn.test/r1.png", unmasked_url: null },
            { kind: "regen", masked_url: "https://cdn.test/r2.png", unmasked_url: "https://cdn.test/r2u.png" },
            { kind: "other", foo: "bar" }, // should be filtered out
          ],
        },
        trend_briefs: null,
      },
    ];
    const { mod } = await loadModule({ design_packages: { rows } });

    const queue = await mod.getDesignReviewQueue();

    expect(queue[0].regen_stack).toHaveLength(2);
    expect(queue[0].regen_stack[0].masked_url).toBe("https://cdn.test/r1.png");
  });
});

describe("getRecentDesigns", () => {
  it("returns rows with has_blocking_listing=false when no listings reference them", async () => {
    const rows = [{ id: "dp-1" }, { id: "dp-2" }];
    const { mod } = await loadModule({ design_packages: { rows } });

    const result = await mod.getRecentDesigns(24);

    expect(result).toEqual([
      { id: "dp-1", has_blocking_listing: false },
      { id: "dp-2", has_blocking_listing: false },
    ]);
  });

  it("marks has_blocking_listing=true for designs with a non-error listing", async () => {
    const rows = [{ id: "dp-1" }, { id: "dp-2" }];
    const { mod } = await loadModule({
      design_packages: { rows },
      listings: { rows: [{ design_package_id: "dp-1", status: "needs_review" }] },
    });

    const result = await mod.getRecentDesigns(24);

    expect(result.find((r) => r.id === "dp-1")?.has_blocking_listing).toBe(true);
    expect(result.find((r) => r.id === "dp-2")?.has_blocking_listing).toBe(false);
  });
});

describe("getDesignSpend", () => {
  it("aggregates fal-provider usage by operation prefix and reports cache hits", async () => {
    const usage = [
      { operation: "flux_pro_v1", cost_usd: 0.05, metadata: null },
      { operation: "flux_pro_v1", cost_usd: 0.05, metadata: { cache_hit: true } },
      { operation: "aura_sr_v2", cost_usd: 0.02, metadata: null },
      { operation: "birefnet_v1", cost_usd: 0.01, metadata: null },
    ];
    const { mod } = await loadModule({
      llm_usage: { rows: usage },
      design_packages: { count: 4 },
    });

    const spend = await mod.getDesignSpend(30);

    expect(spend.flux_pro_usd).toBeCloseTo(0.1, 5);
    expect(spend.aura_sr_usd).toBeCloseTo(0.02, 5);
    expect(spend.birefnet_usd).toBeCloseTo(0.01, 5);
    expect(spend.total_usd).toBeCloseTo(0.13, 5);
    expect(spend.cache_hits).toBe(1);
    expect(spend.designs_done).toBe(4);
    expect(spend.avg_cost_per_design).toBeCloseTo(0.0325, 5);
  });

  it("returns null avg when no designs completed in the window", async () => {
    const { mod } = await loadModule({
      llm_usage: { rows: [] },
      design_packages: { count: 0 },
    });

    const spend = await mod.getDesignSpend(30);

    expect(spend.designs_done).toBe(0);
    expect(spend.avg_cost_per_design).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractRegenStack — unit tests for the regen-stack filter
//
// These guard the isRegenVersion predicate that drives the stack navigation
// arrows in DesignReviewCard and TouchUpCard. A filtering bug silently
// collapses a multi-version stack to a single synthetic entry, removing
// the nav arrows with no visible error.
// ---------------------------------------------------------------------------

describe("extractRegenStack", () => {
  it("returns empty array for null metadata", () => {
    expect(extractRegenStack(null)).toEqual([]);
  });

  it("returns empty array when metadata has no image_versions key", () => {
    expect(extractRegenStack({ other_key: "value" })).toEqual([]);
  });

  it("returns empty array when image_versions is not an array", () => {
    expect(extractRegenStack({ image_versions: "bad" })).toEqual([]);
    expect(extractRegenStack({ image_versions: 42 })).toEqual([]);
    expect(extractRegenStack({ image_versions: null })).toEqual([]);
  });

  it("includes entries with masked_url string and unmasked_url null", () => {
    const stack = extractRegenStack({
      image_versions: [
        { kind: "regen", masked_url: "https://cdn.test/a.png", unmasked_url: null },
      ],
    });
    expect(stack).toHaveLength(1);
    expect(stack[0].masked_url).toBe("https://cdn.test/a.png");
  });

  it("includes entries with both masked_url and unmasked_url as strings", () => {
    const stack = extractRegenStack({
      image_versions: [
        { kind: "regen", masked_url: "https://cdn.test/a.png", unmasked_url: "https://cdn.test/a-u.png" },
      ],
    });
    expect(stack).toHaveLength(1);
    expect(stack[0].unmasked_url).toBe("https://cdn.test/a-u.png");
  });

  it("includes backfilled entries (backfilled:true, image_model:null)", () => {
    // Backfilled entries are synthetic first entries created when a design
    // with no prior regen history gets its first new regen. They must pass
    // the filter or the stack collapses to a single synthetic entry.
    const stack = extractRegenStack({
      image_versions: [
        {
          kind: "regen",
          masked_url: "https://cdn.test/backfill.png",
          unmasked_url: "https://cdn.test/backfill-u.png",
          backfilled: true,
          image_model: null,
          image_quality: null,
          bg_removal_mode: null,
          created_at: "2026-05-17T00:00:00Z",
          prompt: "some prompt",
        },
      ],
    });
    expect(stack).toHaveLength(1);
  });

  it("includes entries with new cost_usd field (cost tracking addition)", () => {
    // Entries written after the cost-tracking feature include cost_usd.
    // Ensure the filter still passes them through.
    const stack = extractRegenStack({
      image_versions: [
        {
          kind: "regen",
          masked_url: "https://cdn.test/a.png",
          unmasked_url: null,
          cost_usd: 0.068,
        },
      ],
    });
    expect(stack).toHaveLength(1);
  });

  it("excludes entries where unmasked_url is undefined (missing key)", () => {
    // This is the silent-failure case: if unmasked_url is absent from the
    // JSON object (rather than explicitly null), isRegenVersion returns false
    // and the entry is dropped. Existing code handles this correctly; this
    // test prevents a future refactor from breaking the null-vs-undefined
    // distinction.
    const stack = extractRegenStack({
      image_versions: [
        { kind: "regen", masked_url: "https://cdn.test/a.png" }, // no unmasked_url key
      ],
    });
    expect(stack).toHaveLength(0);
  });

  it("filters out non-regen kinds (ai_original, hand_edit)", () => {
    const stack = extractRegenStack({
      image_versions: [
        { kind: "ai_original", url: "https://cdn.test/o.png", uploaded_at: "2026-01-01" },
        { kind: "hand_edit", url: "https://cdn.test/h.png", uploaded_at: "2026-01-02" },
        { kind: "regen", masked_url: "https://cdn.test/r.png", unmasked_url: null },
      ],
    });
    expect(stack).toHaveLength(1);
    expect(stack[0].masked_url).toBe("https://cdn.test/r.png");
  });

  it("preserves ordering of multiple valid regen entries", () => {
    const stack = extractRegenStack({
      image_versions: [
        { kind: "regen", masked_url: "https://cdn.test/v1.png", unmasked_url: null },
        { kind: "regen", masked_url: "https://cdn.test/v2.png", unmasked_url: null },
        { kind: "regen", masked_url: "https://cdn.test/v3.png", unmasked_url: null },
      ],
    });
    expect(stack).toHaveLength(3);
    expect(stack[0].masked_url).toBe("https://cdn.test/v1.png");
    expect(stack[2].masked_url).toBe("https://cdn.test/v3.png");
  });
});

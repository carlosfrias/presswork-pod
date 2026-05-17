import { describe, it, expect, vi } from "vitest";
import { makeSupabaseMock, type SupabaseMockOpts } from "@/tests/helpers/supabase-mock";

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

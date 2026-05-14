import { describe, it, expect, vi } from "vitest";
import { makeSupabaseMock, type SupabaseMockOpts } from "@/tests/helpers/supabase-mock";

async function loadModule(opts: SupabaseMockOpts) {
  const { client, capture } = makeSupabaseMock(opts);
  vi.doMock("@/lib/supabase/server", () => ({ serviceClient: () => client }));
  vi.resetModules();
  const mod = await import("./scout");
  return { mod, capture };
}

describe("getScoutStatusCounts", () => {
  it("returns the count for each pipeline status in the human-gated order", async () => {
    const { mod } = await loadModule({ trend_briefs: { count: 7 } });

    const counts = await mod.getScoutStatusCounts();

    expect(counts.map((c) => c.status)).toEqual([
      "needs_review",
      "approved",
      "processing",
      "done",
      "error",
    ]);
    for (const c of counts) expect(c.count).toBe(7);
  });
});

describe("getBriefReviewQueue", () => {
  it("returns briefs awaiting human review", async () => {
    const briefs = [
      { id: "b1", niche: "cats", status: "needs_review", created_at: "2026-05-01" },
    ];
    const { mod, capture } = await loadModule({ trend_briefs: { rows: briefs } });

    const result = await mod.getBriefReviewQueue();

    expect(result).toEqual(briefs);
    expect(capture.selects[0].table).toBe("trend_briefs");
  });
});

describe("getRecentBriefs", () => {
  it("hides Builder-spawned children but keeps parent briefs", async () => {
    const briefs = [
      {
        id: "parent",
        niche: "cats",
        claude_analysis: { source: "scout" },
        created_at: "2026-05-02",
      },
      {
        id: "child",
        niche: "cats",
        claude_analysis: { source: "builder_spawn" },
        created_at: "2026-05-01",
      },
      {
        id: "legacy",
        niche: "dogs",
        claude_analysis: null,
        created_at: "2026-04-30",
      },
    ];
    const { mod } = await loadModule({ trend_briefs: { rows: briefs } });

    const result = await mod.getRecentBriefs(20);

    expect(result.map((b) => b.id)).toEqual(["parent", "legacy"]);
  });
});

describe("getNichePerformance", () => {
  it("aggregates briefs, designs, listings, and revenue per niche", async () => {
    const rows = [
      {
        niche: "cats",
        design_packages: [
          {
            id: "d1",
            status: "done",
            listings: [
              {
                id: "l1",
                is_active: true,
                orders: [
                  { sale_price_usd: 25, margin_usd: 9 },
                  { sale_price_usd: 25, margin_usd: 9 },
                ],
              },
            ],
          },
        ],
      },
      {
        niche: "cats",
        design_packages: [],
      },
      {
        niche: "dogs",
        design_packages: [
          {
            id: "d2",
            status: "needs_review",
            listings: null,
          },
        ],
      },
    ];
    const { mod } = await loadModule({ trend_briefs: { rows } });

    const result = await mod.getNichePerformance(20);

    const cats = result.find((r) => r.niche === "cats");
    const dogs = result.find((r) => r.niche === "dogs");

    expect(cats).toEqual({
      niche: "cats",
      briefs: 2,
      designs: 1,
      listings_active: 1,
      revenue_usd: 50,
      margin_usd: 18,
    });
    expect(dogs?.briefs).toBe(1);
    expect(dogs?.designs).toBe(0); // status was needs_review, not done
    // cats has more revenue → sorted first
    expect(result[0].niche).toBe("cats");
  });
});

import { describe, it, expect, vi } from "vitest";
import { makeSupabaseMock, type SupabaseMockOpts } from "@/tests/helpers/supabase-mock";

async function loadModule(opts: SupabaseMockOpts) {
  const { client, capture } = makeSupabaseMock(opts);
  vi.doMock("@/lib/supabase/server", () => ({ serviceClient: () => client }));
  vi.resetModules();
  const mod = await import("./listings");
  return { mod, capture };
}

function makeRawListing(id: string, status: string, updated_at = "2026-05-10T00:00:00Z") {
  return {
    id,
    status,
    updated_at,
    design_packages: {
      id: "dp-1",
      image_url: "https://cdn.test/design.png",
      mockup_urls: ["https://cdn.test/m1.png"],
      printify_blueprint_id: 145,
      mockups_from_actual_design: true,
      trend_briefs: { id: "tb-1", niche: "cats" },
    },
  };
}

describe("getListingStatusCounts", () => {
  it("returns counts for all 6 listing statuses in flow order", async () => {
    const { mod } = await loadModule({ listings: { count: 3 } });

    const counts = await mod.getListingStatusCounts();

    expect(counts.map((c) => c.status)).toEqual([
      "pending",
      "needs_review",
      "pending_publish",
      "publishing",
      "active",
      "error",
    ]);
    for (const c of counts) expect(c.count).toBe(3);
  });
});

describe("getNeedsReviewQueue / getListingsByStatus", () => {
  it("flattens the design_packages → trend_briefs join into a flat listing+trend_brief shape", async () => {
    const raw = [makeRawListing("l1", "needs_review")];
    const { mod } = await loadModule({ listings: { rows: raw } });

    const result = await mod.getNeedsReviewQueue();

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("l1");
    expect(result[0].design_packages?.id).toBe("dp-1");
    // critical: the nested trend_briefs inside design_packages is lifted to a top-level trend_brief
    expect(result[0].trend_brief).toEqual({ id: "tb-1", niche: "cats" });
  });
});

describe("getListing", () => {
  it("returns a flattened listing when found by id", async () => {
    const { mod } = await loadModule({ listings: { maybeSingle: makeRawListing("l1", "active") } });

    const result = await mod.getListing("l1");

    expect(result?.id).toBe("l1");
    expect(result?.trend_brief?.niche).toBe("cats");
  });

  it("returns null when not found", async () => {
    const { mod } = await loadModule({ listings: { maybeSingle: null } });

    const result = await mod.getListing("missing");

    expect(result).toBeNull();
  });
});

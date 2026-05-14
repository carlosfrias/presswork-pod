import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSupabaseMock, makeFormData, type SupabaseMockOpts } from "@/tests/helpers/supabase-mock";

vi.mock("@/lib/auth", () => ({
  requireOwnerEmail: vi.fn(async () => "owner@test.com"),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/actions/triggers", () => ({
  spawnAgentForOperatorAction: vi.fn(async () => undefined),
}));

async function loadModule(opts: SupabaseMockOpts) {
  const { client, capture } = makeSupabaseMock(opts);
  vi.doMock("@/lib/supabase/server", () => ({ serviceClient: () => client }));
  vi.resetModules();
  const mod = await import("./design");
  const { revalidatePath } = await import("next/cache");
  return { mod, capture, revalidatePath: revalidatePath as ReturnType<typeof vi.fn> };
}

const VALID_ID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("approveDesign", () => {
  it("transitions needs_review → approved with optimistic-concurrency filter", async () => {
    const { mod, capture, revalidatePath } = await loadModule({
      design_packages: {
        maybeSingle: {
          status: "needs_review",
          metadata: null,
          image_url: "https://cdn.test/img.png",
          image_url_unmasked: null,
        },
      },
    });

    await mod.approveDesign(makeFormData({ id: VALID_ID }));

    expect(capture.updates).toHaveLength(1);
    const upd = capture.updates[0];
    expect(upd.table).toBe("design_packages");
    expect(upd.data).toMatchObject({ status: "approved", error_message: null });
    expect(upd.filters).toContainEqual(["id", VALID_ID]);
    expect(upd.filters).toContainEqual(["status", "needs_review"]);
    expect(revalidatePath).toHaveBeenCalledWith("/design");
    expect(revalidatePath).toHaveBeenCalledWith("/listings");
  });

  it("throws when design is not in needs_review", async () => {
    const { mod } = await loadModule({
      design_packages: { maybeSingle: { status: "processing", metadata: null } },
    });

    await expect(mod.approveDesign(makeFormData({ id: VALID_ID }))).rejects.toThrow(
      /Cannot approve from status='processing'/,
    );
  });
});

describe("reopenDesign", () => {
  it("transitions approved → needs_review when no listing blocks it", async () => {
    const { mod, capture } = await loadModule({
      design_packages: { maybeSingle: { status: "approved" } },
      listings: { count: 0 },
    });

    await mod.reopenDesign(makeFormData({ id: VALID_ID }));

    expect(capture.updates).toHaveLength(1);
    const upd = capture.updates[0];
    expect(upd.data).toEqual({ status: "needs_review", error_message: null });
    expect(upd.filters).toContainEqual(["status", "approved"]);
  });

  it("refuses to reopen when a non-error listing references the design", async () => {
    const { mod } = await loadModule({
      design_packages: { maybeSingle: { status: "approved" } },
      listings: { count: 1 },
    });

    await expect(mod.reopenDesign(makeFormData({ id: VALID_ID }))).rejects.toThrow(
      /Cannot reopen: 1 listing/,
    );
  });
});

describe("injectDesign", () => {
  it("inserts a manual design brief at status='approved' with the dashboard_inject_design tag", async () => {
    const { mod, capture } = await loadModule({ trend_briefs: {} });

    await mod.injectDesign(
      makeFormData({
        niche: "cat lovers",
        image_description: "A cat in a bow tie, watercolor sketch with soft pastel palette.",
        image_model: "fal_gpt_image_2",
        image_quality: "high",
        color_palette: JSON.stringify(["#ff0000", "#00ff00"]),
      }),
    );

    expect(capture.inserts[0].table).toBe("trend_briefs");
    expect(capture.inserts[0].data).toMatchObject({
      niche: "cat lovers",
      status: "approved",
      image_model: "fal_gpt_image_2",
      image_quality: "high",
      color_palette: ["#ff0000", "#00ff00"],
      claude_analysis: { source: "dashboard_inject_design" },
    });
  });

  it("nulls image_quality for FLUX (which has no quality tier)", async () => {
    const { mod, capture } = await loadModule({ trend_briefs: {} });

    await mod.injectDesign(
      makeFormData({
        niche: "cat lovers",
        image_description:
          "A cat illustration print on demand design, transparent background, high resolution, vector-style on a solid white background.",
        image_model: "fal_flux_pro",
        image_quality: "high",
        color_palette: JSON.stringify([]),
      }),
    );

    expect(capture.inserts[0].data).toMatchObject({
      image_model: "fal_flux_pro",
      image_quality: null,
      color_palette: null,
    });
  });
});

describe("deleteDesign", () => {
  it("deletes when no listing references the design", async () => {
    const { mod, capture } = await loadModule({
      listings: { count: 0 },
      design_packages: {},
    });

    await mod.deleteDesign(makeFormData({ id: VALID_ID }));

    expect(capture.deletes[0].table).toBe("design_packages");
    expect(capture.deletes[0].filters).toContainEqual(["id", VALID_ID]);
  });

  it("refuses when a listing references the design", async () => {
    const { mod } = await loadModule({ listings: { count: 1 } });

    await expect(mod.deleteDesign(makeFormData({ id: VALID_ID }))).rejects.toThrow(
      /Cannot delete: 1 listing/,
    );
  });
});

describe("retryDesign", () => {
  it("resets design_packages and reverts the brief to approved, then spawns the agent", async () => {
    const { mod, capture } = await loadModule({
      design_packages: { maybeSingle: { trend_brief_id: "brief-1" } },
      trend_briefs: {},
    });
    const { spawnAgentForOperatorAction } = await import("@/lib/actions/triggers");

    await mod.retryDesign(makeFormData({ id: VALID_ID }));

    // First update is to design_packages, second to trend_briefs
    const dpUpd = capture.updates.find((u) => u.table === "design_packages");
    const tbUpd = capture.updates.find((u) => u.table === "trend_briefs");
    expect(dpUpd?.data).toEqual({ status: "pending", retry_count: 0, error_message: null });
    expect(tbUpd?.data).toEqual({ status: "approved", error_message: null });

    expect(spawnAgentForOperatorAction).toHaveBeenCalledWith("design", "owner@test.com");
  });
});

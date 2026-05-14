import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSupabaseMock, makeFormData, type SupabaseMockOpts } from "@/tests/helpers/supabase-mock";

vi.mock("@/lib/auth", () => ({
  requireOwnerEmail: vi.fn(async () => "owner@test.com"),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/scout/generate-niche", () => ({
  generateNicheBrief: vi.fn(),
  GenerateNicheError: class extends Error {},
}));

async function loadModule(opts: SupabaseMockOpts) {
  const { client, capture } = makeSupabaseMock(opts);
  vi.doMock("@/lib/supabase/server", () => ({ serviceClient: () => client }));
  vi.resetModules();
  const mod = await import("./scout");
  const { revalidatePath } = await import("next/cache");
  return { mod, capture, revalidatePath: revalidatePath as ReturnType<typeof vi.fn> };
}

const VALID_ID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("approveBrief", () => {
  it("transitions needs_review → needs_description with optimistic-concurrency filter, and revalidates /scout, /builder, /", async () => {
    const { mod, capture, revalidatePath } = await loadModule({
      trend_briefs: { maybeSingle: { status: "needs_review" } },
    });

    await mod.approveBrief(makeFormData({ id: VALID_ID }));

    expect(capture.updates).toHaveLength(1);
    const upd = capture.updates[0];
    expect(upd.table).toBe("trend_briefs");
    expect(upd.data).toEqual({ status: "needs_description", error_message: null });
    // Critical: optimistic concurrency filter on the FROM status must be present
    expect(upd.filters).toContainEqual(["id", VALID_ID]);
    expect(upd.filters).toContainEqual(["status", "needs_review"]);

    expect(revalidatePath).toHaveBeenCalledWith("/scout");
    expect(revalidatePath).toHaveBeenCalledWith("/builder");
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it("throws when brief is not in needs_review", async () => {
    const { mod } = await loadModule({
      trend_briefs: { maybeSingle: { status: "processing" } },
    });

    await expect(mod.approveBrief(makeFormData({ id: VALID_ID }))).rejects.toThrow(
      /Cannot approve from status='processing'/,
    );
  });
});

describe("regenerateBrief", () => {
  it("deletes the brief when no design references it", async () => {
    const { mod, capture, revalidatePath } = await loadModule({
      design_packages: { count: 0 },
      trend_briefs: {},
    });

    await mod.regenerateBrief(makeFormData({ id: VALID_ID }));

    expect(capture.deletes).toHaveLength(1);
    expect(capture.deletes[0].table).toBe("trend_briefs");
    expect(capture.deletes[0].filters).toContainEqual(["id", VALID_ID]);
    expect(revalidatePath).toHaveBeenCalledWith("/scout");
  });

  it("refuses when a design references the brief", async () => {
    const { mod } = await loadModule({
      design_packages: { count: 2 },
    });

    await expect(mod.regenerateBrief(makeFormData({ id: VALID_ID }))).rejects.toThrow(
      /Cannot regen: 2 design/,
    );
  });
});

describe("editBrief", () => {
  it("writes a sanitized payload when the brief is in an editable state", async () => {
    const { mod, capture, revalidatePath } = await loadModule({
      trend_briefs: { maybeSingle: { status: "needs_review" } },
    });

    await mod.editBrief(
      makeFormData({
        id: VALID_ID,
        niche: "cat lovers",
        style_keywords: "vintage, pastel",
        top_tags: "cats, tee, art",
        price_target_usd: "24.99",
        color_palette: "#ff0000,#00ff00",
      }),
    );

    expect(capture.updates).toHaveLength(1);
    expect(capture.updates[0].table).toBe("trend_briefs");
    expect(capture.updates[0].data).toEqual({
      niche: "cat lovers",
      style_keywords: ["vintage", "pastel"],
      top_tags: ["cats", "tee", "art"],
      price_target_usd: 24.99,
      color_palette: ["#ff0000", "#00ff00"],
    });
    expect(revalidatePath).toHaveBeenCalledWith("/scout");
    expect(revalidatePath).toHaveBeenCalledWith("/builder");
  });

  it("nulls list fields when the form supplied empty strings", async () => {
    const { mod, capture } = await loadModule({
      trend_briefs: { maybeSingle: { status: "needs_review" } },
    });

    await mod.editBrief(
      makeFormData({
        id: VALID_ID,
        niche: "cat lovers",
        style_keywords: "",
        top_tags: "",
        price_target_usd: "",
        color_palette: "",
      }),
    );

    expect(capture.updates[0].data).toEqual({
      niche: "cat lovers",
      style_keywords: null,
      top_tags: null,
      price_target_usd: null,
      color_palette: null,
    });
  });

  it("refuses to edit briefs in non-editable status", async () => {
    const { mod } = await loadModule({
      trend_briefs: { maybeSingle: { status: "processing" } },
    });

    await expect(
      mod.editBrief(
        makeFormData({
          id: VALID_ID,
          niche: "cat lovers",
          style_keywords: "",
          top_tags: "",
          price_target_usd: "",
          color_palette: "",
        }),
      ),
    ).rejects.toThrow(/Cannot edit brief in status='processing'/);
  });
});

describe("injectBrief", () => {
  it("inserts a needs_review brief with the dashboard_manual_inject source tag", async () => {
    const { mod, capture, revalidatePath } = await loadModule({
      trend_briefs: {},
    });

    await mod.injectBrief(
      makeFormData({
        niche: "cat lovers",
        style_keywords: "vintage",
        top_tags: "cats,tee",
        price_target_usd: "24.99",
        color_palette: "#ff0000",
      }),
    );

    expect(capture.inserts).toHaveLength(1);
    expect(capture.inserts[0].table).toBe("trend_briefs");
    expect(capture.inserts[0].data).toMatchObject({
      niche: "cat lovers",
      status: "needs_review",
      claude_analysis: { source: "dashboard_manual_inject" },
      style_keywords: ["vintage"],
      top_tags: ["cats", "tee"],
      price_target_usd: 24.99,
      color_palette: ["#ff0000"],
    });
    expect(revalidatePath).toHaveBeenCalledWith("/scout");
    expect(revalidatePath).toHaveBeenCalledWith("/builder");
    expect(revalidatePath).toHaveBeenCalledWith("/design");
  });
});

describe("retryBrief", () => {
  it("resets retry_count and sets status back to pending", async () => {
    const { mod, capture } = await loadModule({ trend_briefs: {} });

    await mod.retryBrief(makeFormData({ id: VALID_ID }));

    expect(capture.updates[0].data).toEqual({
      status: "pending",
      retry_count: 0,
      error_message: null,
    });
  });
});

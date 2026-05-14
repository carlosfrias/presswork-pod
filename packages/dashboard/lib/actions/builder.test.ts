import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSupabaseMock, makeFormData, type SupabaseMockOpts } from "@/tests/helpers/supabase-mock";

vi.mock("@/lib/auth", () => ({
  requireOwnerEmail: vi.fn(async () => "owner@test.com"),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/builder/build-prompt", () => ({
  buildPromptDescription: vi.fn(async () => ({
    description: "A bulldog trashman, screen print style, mustard/olive/cream palette.",
    cost_usd: 0.012,
  })),
  BuildPromptError: class extends Error {},
}));

async function loadModule(opts: SupabaseMockOpts) {
  const { client, capture } = makeSupabaseMock(opts);
  vi.doMock("@/lib/supabase/server", () => ({ serviceClient: () => client }));
  vi.resetModules();
  const mod = await import("./builder");
  const { revalidatePath } = await import("next/cache");
  return { mod, capture, revalidatePath: revalidatePath as ReturnType<typeof vi.fn> };
}

const VALID_ID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sendToDesign", () => {
  it("clones a child brief at status='approved' tagged builder_spawn", async () => {
    const { mod, capture, revalidatePath } = await loadModule({
      trend_briefs: {
        maybeSingle: {
          id: VALID_ID,
          status: "needs_description",
          niche: "cats",
          style_keywords: ["vintage"],
          top_tags: ["tee"],
          color_palette: ["#ff0000"],
          price_target_usd: 24.99,
          raw_etsy_data: { source: "etsy" },
          claude_analysis: { source: "scout" },
          image_model: "fal_gpt_image_2",
          image_quality: "high",
        },
      },
    });

    await mod.sendToDesign(
      makeFormData({
        id: VALID_ID,
        description: "A bulldog trashman in screen-print style with a mustard palette",
        style: "screen_print",
        image_model: "fal_nano_banana_2",
      }),
    );

    expect(capture.inserts).toHaveLength(1);
    expect(capture.inserts[0].table).toBe("trend_briefs");
    expect(capture.inserts[0].data).toMatchObject({
      niche: "cats",
      style_keywords: ["vintage"],
      status: "approved",
      // operator override on image_model
      image_model: "fal_nano_banana_2",
      image_description: "A bulldog trashman in screen-print style with a mustard palette",
      claude_analysis: {
        source: "builder_spawn",
        parent_brief_id: VALID_ID,
        style: "screen_print",
      },
    });

    expect(revalidatePath).toHaveBeenCalledWith("/builder");
    expect(revalidatePath).toHaveBeenCalledWith("/design");
  });

  it("inherits the parent's image_model when the operator left it on Auto", async () => {
    const { mod, capture } = await loadModule({
      trend_briefs: {
        maybeSingle: {
          id: VALID_ID,
          status: "needs_description",
          niche: "cats",
          style_keywords: null,
          top_tags: null,
          color_palette: null,
          price_target_usd: null,
          raw_etsy_data: null,
          claude_analysis: null,
          image_model: "fal_flux_pro",
          image_quality: null,
        },
      },
    });

    await mod.sendToDesign(
      makeFormData({
        id: VALID_ID,
        description: "A bulldog trashman in screen-print style",
        style: "",
        image_model: "",
      }),
    );

    expect(capture.inserts[0].data).toMatchObject({
      image_model: "fal_flux_pro",
      status: "approved",
    });
  });

  it("throws when brief is not in needs_description", async () => {
    const { mod } = await loadModule({
      trend_briefs: {
        maybeSingle: { id: VALID_ID, status: "processing" },
      },
    });

    await expect(
      mod.sendToDesign(
        makeFormData({
          id: VALID_ID,
          description: "A bulldog trashman in screen-print style",
        }),
      ),
    ).rejects.toThrow(/Cannot send from status='processing'/);
  });
});

describe("createManualBrief", () => {
  it("creates a manual brief at status='approved' tagged builder_manual", async () => {
    const { mod, capture, revalidatePath } = await loadModule({ trend_briefs: {} });

    await mod.createManualBrief(
      makeFormData({
        niche: "cat lovers",
        description: "A cat in a bow tie, watercolor sketch",
        style: "watercolor_sketch",
        image_model: "fal_gpt_image_2",
      }),
    );

    expect(capture.inserts[0].data).toMatchObject({
      niche: "cat lovers",
      image_description: "A cat in a bow tie, watercolor sketch",
      status: "approved",
      claude_analysis: { source: "builder_manual", style: "watercolor_sketch" },
      image_model: "fal_gpt_image_2",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/builder");
    expect(revalidatePath).toHaveBeenCalledWith("/design");
  });

  it("defaults niche to 'original design' when omitted", async () => {
    const { mod, capture } = await loadModule({ trend_briefs: {} });

    await mod.createManualBrief(
      makeFormData({
        niche: "",
        description: "A cat in a bow tie, watercolor sketch",
      }),
    );

    expect(capture.inserts[0].data).toMatchObject({ niche: "original design" });
  });
});

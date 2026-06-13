import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSupabaseMock, makeFormData, type SupabaseMockOpts } from "@/tests/helpers/supabase-mock";

vi.mock("@/lib/auth", () => ({
  requireOwnerEmail: vi.fn(async () => "owner@test.com"),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Module-level handles to the mocks — re-bound inside loadModule so each
// test gets fresh spies without side-effects bleeding between cases.
// Loose typing — vi.fn() is defaulted to a generic Mock<any[], unknown>
// which lets tests reassign with whatever return shape they need without
// the per-spy generic being baked in at module top.
let mockUpdateActiveListing: ReturnType<typeof vi.fn> = vi.fn();
let mockRenderMockup: ReturnType<typeof vi.fn> = vi.fn();
let mockDynamicMockupsTemplate: ReturnType<typeof vi.fn> = vi.fn();
let mockDynamicMockupsTemplates: ReturnType<typeof vi.fn> = vi.fn();
let mockResumePublish: ReturnType<typeof vi.fn> = vi.fn();

interface LoadOpts extends SupabaseMockOpts {}
interface LoadShared {
  /**
   * Override the per-blueprint template lookup return for this test.
   * `undefined` → both lookups return empty (singular returns undefined,
   * plural returns []), simulating an unregistered blueprint.
   * A single object → both lookups return it (plural wraps in a 1-element
   * array), mimicking the common single-template registration.
   */
  template?:
    | { mockupUuid: string; smartObjectUuid: string; garmentSmartObjectUuid?: string }
    | undefined;
}

async function loadModule(opts: LoadOpts, shared: LoadShared = {}) {
  mockUpdateActiveListing = vi.fn().mockResolvedValue(undefined);
  mockRenderMockup = vi
    .fn()
    .mockResolvedValue("https://cdn.dynamicmockups.example/render.jpg");
  mockDynamicMockupsTemplate = vi.fn(
    () => shared.template,
  ) as ReturnType<typeof vi.fn>;
  mockDynamicMockupsTemplates = vi.fn(
    () => (shared.template ? [shared.template] : []),
  ) as ReturnType<typeof vi.fn>;
  mockResumePublish = vi.fn().mockResolvedValue(undefined);

  vi.doMock("@presswork/shared", async () => {
    const actual = await vi.importActual<typeof import("@presswork/shared")>(
      "@presswork/shared",
    );
    return {
      ...actual,
      updateActiveListing: mockUpdateActiveListing,
      renderMockup: mockRenderMockup,
      dynamicMockupsTemplate: mockDynamicMockupsTemplate,
      dynamicMockupsTemplates: mockDynamicMockupsTemplates,
    };
  });
  vi.doMock("@presswork/listing/publish", () => ({
    resumePublish: mockResumePublish,
  }));
  const { client, capture } = makeSupabaseMock(opts);
  vi.doMock("@/lib/supabase/server", () => ({ serviceClient: () => client }));
  vi.resetModules();
  const mod = await import("./listings");
  const { revalidatePath } = await import("next/cache");
  return {
    mod,
    capture,
    revalidatePath: revalidatePath as ReturnType<typeof vi.fn>,
    updateActiveListingSpy: mockUpdateActiveListing,
    renderMockupSpy: mockRenderMockup,
    resumePublishSpy: mockResumePublish,
  };
}

const AI_DISCLOSURE =
  "This design was created using AI image generation tools, hand-selected and quality-reviewed by our team before printing.";
const COMPLIANT_DESCRIPTION = `A great shirt. ${AI_DISCLOSURE}`;
const COMPLIANT_TAGS = [
  "cat shirt", "cat tee", "funny cat", "cat lover", "unisex",
  "graphic tee", "cat mom", "cat dad", "pet lover", "animal",
  "cute cat", "cat design", "novelty",
].join(",");

const VALID_ID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("approveListing", () => {
  it("transitions needs_review → pending_publish with optimistic-concurrency filter and logs llm_usage", async () => {
    const { mod, capture, revalidatePath } = await loadModule({
      listings: {
        maybeSingle: { status: "needs_review", title: "Cat Tee", description: "...", tags: [] },
      },
      llm_usage: {},
    });

    await mod.approveListing(makeFormData({ id: VALID_ID }));

    const upd = capture.updates.find((u) => u.table === "listings");
    expect(upd?.data).toEqual({
      status: "pending_publish",
      error_message: null,
      retry_count: 0,
    });
    expect(upd?.filters).toContainEqual(["status", "needs_review"]);

    // llm_usage breadcrumb captured
    const usageInsert = capture.inserts.find((i) => i.table === "llm_usage");
    expect(usageInsert).toBeDefined();
    expect(usageInsert?.data).toMatchObject({
      agent: "listing",
      provider: "etsy",
      operation: "manual_approve",
    });

    expect(revalidatePath).toHaveBeenCalledWith("/listings");
    expect(revalidatePath).toHaveBeenCalledWith(`/listings/${VALID_ID}`);
  });

  it("throws when listing is not in needs_review", async () => {
    const { mod } = await loadModule({
      listings: { maybeSingle: { status: "publishing" } },
    });

    await expect(mod.approveListing(makeFormData({ id: VALID_ID }))).rejects.toThrow(
      /Cannot approve from status='publishing'/,
    );
  });
});

describe("rejectListing", () => {
  it("transitions needs_review → error with the reason embedded in error_message", async () => {
    const { mod, capture } = await loadModule({
      listings: { maybeSingle: { status: "needs_review" } },
    });

    await mod.rejectListing(makeFormData({ id: VALID_ID, reason: "off-brand" }));

    const upd = capture.updates[0];
    expect(upd.data.status).toBe("error");
    expect(String(upd.data.error_message)).toMatch(/manual reject.*off-brand/);
    // Optimistic concurrency: enforced by `.in("status", ["needs_review", "error"])`.
    // The mock helper passes through .in without capturing filters, so we only
    // verify the eq("id", ...) filter that's the primary key match.
    expect(upd.filters).toContainEqual(["id", VALID_ID]);
  });

  it("send_design_back: nulls FK on listing AND flips design to needs_review", async () => {
    const { mod, capture, revalidatePath } = await loadModule({
      listings: {
        // The status guard query AND the design-link lookup both go through
        // maybeSingle. Returning a row with both fields covers both calls.
        maybeSingle: {
          status: "needs_review",
          design_package_id: "00000000-0000-0000-0000-000000000099",
        },
      },
    });

    await mod.rejectListing(
      makeFormData({
        id: VALID_ID,
        reason: "design has visible artifacts",
        send_design_back: "on",
      }),
    );

    const listingUpd = capture.updates.find((u) => u.table === "listings");
    expect(listingUpd?.data.status).toBe("error");
    // FK nulled so the migration-046 NOT EXISTS guard lets the design re-claim.
    expect(listingUpd?.data.design_package_id).toBeNull();
    expect(String(listingUpd?.data.error_message)).toMatch(
      /design returned to review.*design has visible artifacts/,
    );

    const designUpd = capture.updates.find(
      (u) => u.table === "design_packages",
    );
    expect(designUpd?.data.status).toBe("needs_review");
    expect(designUpd?.data.error_message).toBeNull();

    expect(revalidatePath).toHaveBeenCalledWith("/design");
  });

  it("send_design_back unset: behaves exactly like a plain reject (no design-side write)", async () => {
    const { mod, capture, revalidatePath } = await loadModule({
      listings: {
        maybeSingle: {
          status: "needs_review",
          design_package_id: "00000000-0000-0000-0000-000000000099",
        },
      },
    });

    await mod.rejectListing(
      makeFormData({ id: VALID_ID, reason: "off-brand copy" }),
    );

    const designUpd = capture.updates.find(
      (u) => u.table === "design_packages",
    );
    expect(designUpd).toBeUndefined();
    expect(revalidatePath).not.toHaveBeenCalledWith("/design");
  });

  it("also accepts rejecting from status='error' (Errors-card dismiss)", async () => {
    const { mod, capture } = await loadModule({
      listings: { maybeSingle: { status: "error" } },
    });

    await mod.rejectListing(
      makeFormData({ id: VALID_ID, reason: "not worth fixing" }),
    );

    const upd = capture.updates[0];
    expect(upd.data.status).toBe("error");
    expect(String(upd.data.error_message)).toMatch(/manual reject.*not worth fixing/);
  });
});

describe("retryListing", () => {
  it("resets retry_count and flips back to pending (from error, with a linked design)", async () => {
    const { mod, capture } = await loadModule({
      listings: {
        maybeSingle: {
          status: "error",
          design_package_id: "00000000-0000-0000-0000-000000000099",
        },
      },
    });

    await mod.retryListing(makeFormData({ id: VALID_ID }));

    expect(capture.updates[0].data).toEqual({
      status: "pending",
      retry_count: 0,
      error_message: null,
    });
    // Concurrency guard: only writes when the row is still at 'error'.
    expect(capture.updates[0].filters).toContainEqual(["status", "error"]);
  });

  it("throws when status is not 'error' (stale-tab guard)", async () => {
    const { mod, capture } = await loadModule({
      listings: {
        maybeSingle: {
          status: "active",
          design_package_id: "00000000-0000-0000-0000-000000000099",
        },
      },
    });

    await expect(mod.retryListing(makeFormData({ id: VALID_ID }))).rejects.toThrow(
      /Cannot retry from status='active'/,
    );
    // No write — the guard fired before the update.
    expect(capture.updates).toEqual([]);
  });

  it("refuses (H1) when design_package_id is null — would starve the listing queue", async () => {
    const { mod, capture } = await loadModule({
      listings: { maybeSingle: { status: "error", design_package_id: null } },
    });

    await expect(mod.retryListing(makeFormData({ id: VALID_ID }))).rejects.toThrow(
      /no linked design/i,
    );
    expect(capture.updates).toEqual([]);
  });
});

describe("updateActiveListingCopy", () => {
  it("rejects when listing is not at status='active'", async () => {
    const { mod } = await loadModule({
      listings: { maybeSingle: { status: "needs_review" } },
    });

    await expect(
      mod.updateActiveListingCopy(
        makeFormData({
          id: VALID_ID,
          title: "OK Title",
          description: COMPLIANT_DESCRIPTION,
          tags: COMPLIANT_TAGS,
        }),
      ),
    ).rejects.toThrow(/Cannot edit active-listing copy from status='needs_review'/);
  });

  it("blocks forbidden terms via shared validateCopyCompliance", async () => {
    const { mod, capture } = await loadModule({
      listings: { maybeSingle: { status: "active" } },
    });

    await expect(
      mod.updateActiveListingCopy(
        makeFormData({
          id: VALID_ID,
          title: "Unique Cat Tee", // 'unique' is forbidden
          description: COMPLIANT_DESCRIPTION,
          tags: COMPLIANT_TAGS,
        }),
      ),
    ).rejects.toThrow(/forbidden term\(s\) in listing copy: unique/);

    // No DB write — the gate fired before the update.
    expect(capture.updates).toEqual([]);
  });

  it("happy path: writes title/description/tags only and revalidates", async () => {
    const { mod, capture, revalidatePath } = await loadModule({
      listings: { maybeSingle: { status: "active" } },
    });

    await mod.updateActiveListingCopy(
      makeFormData({
        id: VALID_ID,
        title: "Cat Tee for Cat Lovers",
        description: COMPLIANT_DESCRIPTION,
        tags: COMPLIANT_TAGS,
      }),
    );

    const upd = capture.updates.find((u) => u.table === "listings");
    expect(upd?.data).toEqual({
      title: "Cat Tee for Cat Lovers",
      description: COMPLIANT_DESCRIPTION,
      tags: COMPLIANT_TAGS.split(",").map((t) => t.trim()),
    });
    // Concurrency guard: writes only when status is still 'active'.
    expect(upd?.filters).toContainEqual(["status", "active"]);
    expect(revalidatePath).toHaveBeenCalledWith("/listings");
    expect(revalidatePath).toHaveBeenCalledWith(`/listings/${VALID_ID}`);
  });
});

describe("pushListingToEtsy", () => {
  it("rejects when listing is not at status='active'", async () => {
    const { mod } = await loadModule({
      listings: {
        maybeSingle: {
          status: "needs_review",
          etsy_listing_id: 1,
          title: "x",
          description: "x",
          tags: ["x"],
        },
      },
    });

    await expect(
      mod.pushListingToEtsy(makeFormData({ id: VALID_ID })),
    ).rejects.toThrow(/Cannot push from status='needs_review'/);
  });

  it("rejects when etsy_listing_id is missing", async () => {
    const { mod } = await loadModule({
      listings: {
        maybeSingle: {
          status: "active",
          etsy_listing_id: null,
          title: "x",
          description: "x",
          tags: ["x"],
        },
      },
    });

    await expect(
      mod.pushListingToEtsy(makeFormData({ id: VALID_ID })),
    ).rejects.toThrow(/no etsy_listing_id/);
  });

  it("happy path: calls updateActiveListing with the row's copy and sets last_pushed_at", async () => {
    const { mod, capture, updateActiveListingSpy } = await loadModule({
      listings: {
        maybeSingle: {
          status: "active",
          etsy_listing_id: 999001,
          title: "Cat Tee for Cat Lovers",
          description: COMPLIANT_DESCRIPTION,
          tags: COMPLIANT_TAGS.split(",").map((t) => t.trim()),
        },
      },
    });

    await mod.pushListingToEtsy(makeFormData({ id: VALID_ID }));

    expect(updateActiveListingSpy).toHaveBeenCalledTimes(1);
    const [, etsyListingId, payload] = updateActiveListingSpy.mock.calls[0];
    expect(etsyListingId).toBe(999001);
    expect(payload).toEqual({
      title: "Cat Tee for Cat Lovers",
      description: COMPLIANT_DESCRIPTION,
      tags: COMPLIANT_TAGS.split(",").map((t) => t.trim()),
    });

    const lastPushed = capture.updates.find(
      (u) => u.table === "listings" && "last_pushed_at" in u.data,
    );
    expect(lastPushed).toBeDefined();
    expect(lastPushed!.data["error_message"]).toBeNull();
    expect(typeof lastPushed!.data["last_pushed_at"]).toBe("string");
  });

  it("on Etsy failure: persists the error_message and rethrows", async () => {
    const { mod, capture, updateActiveListingSpy } = await loadModule({
      listings: {
        maybeSingle: {
          status: "active",
          etsy_listing_id: 999001,
          title: "Cat Tee",
          description: COMPLIANT_DESCRIPTION,
          tags: ["a"],
        },
      },
    });
    updateActiveListingSpy.mockRejectedValueOnce(new Error("etsy 500: outage"));

    await expect(
      mod.pushListingToEtsy(makeFormData({ id: VALID_ID })),
    ).rejects.toThrow(/Etsy push failed: etsy 500: outage/);

    const errorWrite = capture.updates.find(
      (u) =>
        u.table === "listings" &&
        typeof u.data["error_message"] === "string" &&
        (u.data["error_message"] as string).includes("etsy 500"),
    );
    expect(errorWrite).toBeDefined();
  });
});

describe("generateDynamicMockups", () => {
  it("rejects when no template is registered for the blueprint", async () => {
    const { mod } = await loadModule(
      {
        listings: {
          maybeSingle: {
            id: VALID_ID,
            status: "needs_review",
            design_packages: {
              id: "00000000-0000-0000-0000-000000000099",
              image_url: "https://cdn.example/design.png",
              printify_blueprint_id: 145,
            },
          },
        },
      },
      { template: undefined },
    );

    await expect(
      mod.generateDynamicMockups(makeFormData({ id: VALID_ID })),
    ).rejects.toThrow(/No Dynamic Mockups template registered for blueprint 145/);
  });

  it("rejects when the design has no image_url", async () => {
    const { mod } = await loadModule(
      {
        listings: {
          maybeSingle: {
            id: VALID_ID,
            status: "needs_review",
            design_packages: {
              id: "00000000-0000-0000-0000-000000000099",
              image_url: null,
              printify_blueprint_id: 145,
            },
          },
        },
      },
      { template: { mockupUuid: "m-uuid", smartObjectUuid: "s-uuid" } },
    );

    await expect(
      mod.generateDynamicMockups(makeFormData({ id: VALID_ID })),
    ).rejects.toThrow(/no image_url/);
  });

  it("happy path: calls renderMockup and replaces design.mockup_urls", async () => {
    const { mod, capture, renderMockupSpy } = await loadModule(
      {
        listings: {
          maybeSingle: {
            id: VALID_ID,
            status: "needs_review",
            design_packages: {
              id: "00000000-0000-0000-0000-000000000099",
              image_url: "https://cdn.example/design.png",
              printify_blueprint_id: 145,
            },
          },
        },
      },
      { template: { mockupUuid: "m-uuid", smartObjectUuid: "s-uuid" } },
    );

    await mod.generateDynamicMockups(makeFormData({ id: VALID_ID }));

    expect(renderMockupSpy).toHaveBeenCalledTimes(1);
    const callArg = renderMockupSpy.mock.calls[0][0] as {
      mockupUuid: string;
      smartObjectUuid: string;
      designUrl: string;
    };
    expect(callArg.mockupUuid).toBe("m-uuid");
    expect(callArg.smartObjectUuid).toBe("s-uuid");
    expect(callArg.designUrl).toBe("https://cdn.example/design.png");

    const dpUpdate = capture.updates.find(
      (u) => u.table === "design_packages" && "mockup_urls" in u.data,
    );
    expect(dpUpdate?.data["mockup_urls"]).toEqual([
      "https://cdn.dynamicmockups.example/render.jpg",
    ]);
    // Compliance flag stays true — the rendered image still composites the
    // actual design into a smart-object slot.
    expect(dpUpdate?.data["mockups_from_actual_design"]).toBe(true);
  });

  it("renders one mockup per offered color when the template has a garment slot", async () => {
    const { mod, renderMockupSpy } = await loadModule(
      {
        listings: {
          maybeSingle: {
            id: VALID_ID,
            status: "needs_review",
            selected_variant_ids: null,
            design_packages: {
              id: "00000000-0000-0000-0000-000000000099",
              image_url: "https://cdn.example/design.png",
              printify_blueprint_id: 145,
              printify_print_provider_id: 39,
              // Offered set spans two colors.
              printify_variant_ids: [38163, 40000],
              mockup_urls: [],
            },
          },
        },
        printify_variant_catalog: {
          rows: [
            { variant_id: 38163, color: "White", size: "S" },
            { variant_id: 40000, color: "Black", size: "M" },
          ],
        },
      },
      {
        template: {
          mockupUuid: "m-uuid",
          smartObjectUuid: "s-uuid",
          garmentSmartObjectUuid: "g-uuid",
        },
      },
    );

    await mod.generateDynamicMockups(makeFormData({ id: VALID_ID }));

    // One render per offered color (catalog sort → Black, then White).
    expect(renderMockupSpy).toHaveBeenCalledTimes(2);
    const calls = renderMockupSpy.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const byColor = new Map(calls.map((a) => [a.color as string, a]));

    expect(byColor.get("#1B1B1B")).toMatchObject({
      smartObjectUuid: "s-uuid",
      colorSmartObjectUuid: "g-uuid",
      designUrl: "https://cdn.example/design.png",
    });
    expect(byColor.get("#FFFFFF")).toMatchObject({
      colorSmartObjectUuid: "g-uuid",
    });
  });

  it("renders a single colorless mockup when the template has no garment slot", async () => {
    const { mod, renderMockupSpy } = await loadModule(
      {
        listings: {
          maybeSingle: {
            id: VALID_ID,
            status: "needs_review",
            selected_variant_ids: null,
            design_packages: {
              id: "00000000-0000-0000-0000-000000000099",
              image_url: "https://cdn.example/design.png",
              printify_blueprint_id: 145,
              printify_print_provider_id: 39,
              printify_variant_ids: [38163, 40000],
              mockup_urls: [],
            },
          },
        },
        printify_variant_catalog: {
          rows: [
            { variant_id: 38163, color: "White", size: "S" },
            { variant_id: 40000, color: "Black", size: "M" },
          ],
        },
      },
      // No garmentSmartObjectUuid → legacy single colorless render.
      { template: { mockupUuid: "m-uuid", smartObjectUuid: "s-uuid" } },
    );

    await mod.generateDynamicMockups(makeFormData({ id: VALID_ID }));

    expect(renderMockupSpy).toHaveBeenCalledTimes(1);
    const arg = renderMockupSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.color).toBeUndefined();
    expect(arg.colorSmartObjectUuid).toBeUndefined();
  });
});

describe("regenerateCopy", () => {
  it("clears title/description/tags and flips back to pending (from needs_review)", async () => {
    const { mod, capture } = await loadModule({
      listings: { maybeSingle: { status: "needs_review" } },
    });

    await mod.regenerateCopy(makeFormData({ id: VALID_ID }));

    expect(capture.updates[0].data).toEqual({
      status: "pending",
      title: null,
      description: null,
      tags: null,
      error_message: null,
    });
  });

  it("rejects from status='active' (stale-tab guard — would null live copy)", async () => {
    const { mod, capture } = await loadModule({
      listings: { maybeSingle: { status: "active" } },
    });

    await expect(
      mod.regenerateCopy(makeFormData({ id: VALID_ID })),
    ).rejects.toThrow(/Cannot regenerate copy from status='active'/);
    expect(capture.updates).toEqual([]);
  });
});

describe("recreatePrintifyProduct", () => {
  it("clears printify_product_id and flips back to pending (from error)", async () => {
    const { mod, capture } = await loadModule({
      listings: { maybeSingle: { status: "error" } },
    });

    await mod.recreatePrintifyProduct(makeFormData({ id: VALID_ID }));

    expect(capture.updates[0].data).toEqual({
      status: "pending",
      printify_product_id: null,
      error_message: null,
    });
  });

  it("rejects from status='active' (stale-tab guard — would null product id)", async () => {
    const { mod, capture } = await loadModule({
      listings: { maybeSingle: { status: "active" } },
    });

    await expect(
      mod.recreatePrintifyProduct(makeFormData({ id: VALID_ID })),
    ).rejects.toThrow(/Cannot recreate Printify product from status='active'/);
    expect(capture.updates).toEqual([]);
  });
});

describe("publishListingNow", () => {
  /** Helper: build FormData that may include multiple values for the same key */
  function makePublishFormData(id: string, selectedImageUrls?: string[]): FormData {
    const fd = new FormData();
    fd.set("id", id);
    if (selectedImageUrls) {
      for (const url of selectedImageUrls) {
        fd.append("selectedImageUrls", url);
      }
    }
    return fd;
  }

  it("enforces owner + pending_publish status guard — rejects when listing is not pending_publish", async () => {
    const { mod } = await loadModule({
      listings: { maybeSingle: { status: "needs_review" } },
    });

    await expect(
      mod.publishListingNow(makePublishFormData(VALID_ID)),
    ).rejects.toThrow(/Cannot publish.*status='needs_review'.*pending_publish/);
  });

  it("enforces owner + pending_publish status guard — rejects when listing not found", async () => {
    const { mod } = await loadModule({
      listings: { maybeSingle: null },
    });

    await expect(
      mod.publishListingNow(makePublishFormData(VALID_ID)),
    ).rejects.toThrow(/Listing not found/);
  });

  it("no selection: calls resumePublish with empty opts (upload-all preserved)", async () => {
    const { mod, resumePublishSpy, revalidatePath } = await loadModule({
      listings: { maybeSingle: { status: "pending_publish" } },
    });

    await mod.publishListingNow(makePublishFormData(VALID_ID));

    expect(resumePublishSpy).toHaveBeenCalledTimes(1);
    const [, calledId, calledOpts] = resumePublishSpy.mock.calls[0];
    expect(calledId).toBe(VALID_ID);
    expect(calledOpts).toEqual({});

    expect(revalidatePath).toHaveBeenCalledWith("/listings");
    expect(revalidatePath).toHaveBeenCalledWith(`/listings/${VALID_ID}`);
  });

  it("forwards parsed selection: resumePublish receives selectedMockupUrls in order", async () => {
    const { mod, resumePublishSpy } = await loadModule({
      listings: { maybeSingle: { status: "pending_publish" } },
    });

    const urls = [
      "https://cdn.printify.com/mockup-a.jpg",
      "https://cdn.printify.com/mockup-b.jpg",
    ];

    await mod.publishListingNow(makePublishFormData(VALID_ID, urls));

    expect(resumePublishSpy).toHaveBeenCalledTimes(1);
    const [, calledId, calledOpts] = resumePublishSpy.mock.calls[0];
    expect(calledId).toBe(VALID_ID);
    expect(calledOpts).toEqual({ selectedMockupUrls: urls });
  });

  it("rejects when a selectedImageUrl value is not a valid URL", async () => {
    const { mod } = await loadModule({
      listings: { maybeSingle: { status: "pending_publish" } },
    });

    const fd = new FormData();
    fd.set("id", VALID_ID);
    fd.append("selectedImageUrls", "not-a-url");

    await expect(mod.publishListingNow(fd)).rejects.toThrow(
      /Invalid selectedImageUrls/,
    );
  });
});

describe("updateListingVariants", () => {
  /** Listing row joined with its design's blueprint/provider. */
  const LISTING_WITH_DESIGN = {
    id: VALID_ID,
    design_packages: {
      printify_blueprint_id: 145,
      printify_print_provider_id: 39,
    },
  };

  /** Catalog universe: a design-default White id plus a non-default Black id. */
  const CATALOG = {
    rows: [
      { variant_id: 38163, color: "White", size: "S" },
      { variant_id: 40000, color: "Black", size: "M" },
    ],
  };

  function makeVariantFormData(id: string, variantIds: number[]): FormData {
    const fd = new FormData();
    fd.set("id", id);
    for (const v of variantIds) fd.append("selectedVariantIds", String(v));
    return fd;
  }

  it("accepts a catalog id outside the design's shipped set (add-color)", async () => {
    const { mod, capture } = await loadModule({
      listings: { maybeSingle: LISTING_WITH_DESIGN },
      printify_variant_catalog: CATALOG,
    });

    // 40000 (Black/M) is NOT a design default but IS in the catalog.
    await mod.updateListingVariants(makeVariantFormData(VALID_ID, [38163, 40000]));

    const update = capture.updates.find((u) => u.table === "listings");
    expect(update?.data).toEqual({ selected_variant_ids: [38163, 40000] });
  });

  it("rejects an id that is not in the catalog at all", async () => {
    const { mod } = await loadModule({
      listings: { maybeSingle: LISTING_WITH_DESIGN },
      printify_variant_catalog: CATALOG,
    });

    await expect(
      mod.updateListingVariants(makeVariantFormData(VALID_ID, [99999])),
    ).rejects.toThrow(/not present in/i);
  });

  it("stores NULL when the selection is empty (inherit design set)", async () => {
    const { mod, capture } = await loadModule({
      listings: { maybeSingle: LISTING_WITH_DESIGN },
      printify_variant_catalog: CATALOG,
    });

    await mod.updateListingVariants(makeVariantFormData(VALID_ID, []));

    const update = capture.updates.find((u) => u.table === "listings");
    expect(update?.data).toEqual({ selected_variant_ids: null });
  });

  it("throws when the listing is not found", async () => {
    const { mod } = await loadModule({
      listings: { maybeSingle: null },
      printify_variant_catalog: CATALOG,
    });

    await expect(
      mod.updateListingVariants(makeVariantFormData(VALID_ID, [38163])),
    ).rejects.toThrow(/Listing not found/);
  });
});

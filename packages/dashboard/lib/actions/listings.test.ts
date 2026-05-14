import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSupabaseMock, makeFormData, type SupabaseMockOpts } from "@/tests/helpers/supabase-mock";

vi.mock("@/lib/auth", () => ({
  requireOwnerEmail: vi.fn(async () => "owner@test.com"),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

async function loadModule(opts: SupabaseMockOpts) {
  const { client, capture } = makeSupabaseMock(opts);
  vi.doMock("@/lib/supabase/server", () => ({ serviceClient: () => client }));
  vi.resetModules();
  const mod = await import("./listings");
  const { revalidatePath } = await import("next/cache");
  return { mod, capture, revalidatePath: revalidatePath as ReturnType<typeof vi.fn> };
}

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
    expect(upd.filters).toContainEqual(["status", "needs_review"]);
  });
});

describe("retryListing", () => {
  it("resets retry_count and flips back to pending", async () => {
    const { mod, capture } = await loadModule({ listings: {} });

    await mod.retryListing(makeFormData({ id: VALID_ID }));

    expect(capture.updates[0].data).toEqual({
      status: "pending",
      retry_count: 0,
      error_message: null,
    });
  });
});

describe("regenerateCopy", () => {
  it("clears title/description/tags and flips back to pending", async () => {
    const { mod, capture } = await loadModule({ listings: {} });

    await mod.regenerateCopy(makeFormData({ id: VALID_ID }));

    expect(capture.updates[0].data).toEqual({
      status: "pending",
      title: null,
      description: null,
      tags: null,
      error_message: null,
    });
  });
});

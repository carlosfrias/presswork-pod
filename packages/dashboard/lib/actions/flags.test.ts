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
  const mod = await import("./flags");
  const { revalidatePath } = await import("next/cache");
  return { mod, capture, revalidatePath: revalidatePath as ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("setRuntimeFlag", () => {
  it("upserts a JSON-decoded value tagged with the operator email", async () => {
    const { mod, capture, revalidatePath } = await loadModule({ runtime_flags: {} });

    await mod.setRuntimeFlag(makeFormData({ key: "vision_enabled", value: "true" }));

    expect(capture.upserts).toHaveLength(1);
    expect(capture.upserts[0].table).toBe("runtime_flags");
    expect(capture.upserts[0].data).toMatchObject({
      key: "vision_enabled",
      value: true,
      updated_by: "owner@test.com",
    });
    // All five paths invalidated
    for (const p of ["/", "/scout", "/design", "/listings", "/ledger"]) {
      expect(revalidatePath).toHaveBeenCalledWith(p);
    }
  });

  it("falls back to raw string when the value is not valid JSON (e.g. 'birefnet')", async () => {
    const { mod, capture } = await loadModule({ runtime_flags: {} });

    await mod.setRuntimeFlag(makeFormData({ key: "bg_removal_default", value: "birefnet" }));

    expect(capture.upserts[0].data).toMatchObject({
      key: "bg_removal_default",
      value: "birefnet",
    });
  });
});

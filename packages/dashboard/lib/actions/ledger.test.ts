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
  const mod = await import("./ledger");
  const { revalidatePath } = await import("next/cache");
  return { mod, capture, revalidatePath: revalidatePath as ReturnType<typeof vi.fn> };
}

const VALID_ID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("retryOrder", () => {
  it("resets retry_count and flips status back to logged", async () => {
    const { mod, capture, revalidatePath } = await loadModule({ orders: {} });

    await mod.retryOrder(makeFormData({ id: VALID_ID }));

    expect(capture.updates[0].table).toBe("orders");
    expect(capture.updates[0].data).toEqual({
      status: "logged",
      retry_count: 0,
      error_message: null,
    });
    expect(capture.updates[0].filters).toContainEqual(["id", VALID_ID]);
    expect(revalidatePath).toHaveBeenCalledWith("/ledger");
  });
});

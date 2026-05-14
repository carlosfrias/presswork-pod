import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSupabaseMock } from "@/tests/helpers/supabase-mock";

const { client, capture } = makeSupabaseMock({});

vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => client,
}));

beforeEach(() => {
  capture.selects.length = 0;
});

describe("getBuilderQueue", () => {
  it("returns trend_briefs rows in status='needs_description', oldest first", async () => {
    const briefs = [
      { id: "b1", niche: "cats", status: "needs_description", created_at: "2026-05-01" },
      { id: "b2", niche: "dogs", status: "needs_description", created_at: "2026-05-02" },
    ];
    const { client: c, capture: cap } = makeSupabaseMock({
      trend_briefs: { rows: briefs },
    });
    vi.doMock("@/lib/supabase/server", () => ({ serviceClient: () => c }));
    vi.resetModules();
    const { getBuilderQueue } = await import("./builder");

    const result = await getBuilderQueue();

    expect(result).toEqual(briefs);
    expect(cap.selects[0].table).toBe("trend_briefs");
  });

  it("returns [] when Supabase reports an error (graceful degradation)", async () => {
    const { client: c } = makeSupabaseMock({
      trend_briefs: { rows: [], selectError: { message: "boom" } },
    });
    vi.doMock("@/lib/supabase/server", () => ({ serviceClient: () => c }));
    vi.resetModules();
    const { getBuilderQueue } = await import("./builder");

    // suppress expected error log from the implementation
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await getBuilderQueue();
    spy.mockRestore();

    expect(result).toEqual([]);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSupabaseMock, type SupabaseMockOpts } from "@/tests/helpers/supabase-mock";

async function loadModule(opts: SupabaseMockOpts) {
  const { client, capture } = makeSupabaseMock(opts);
  vi.doMock("@/lib/supabase/server", () => ({ serviceClient: () => client }));
  vi.resetModules();
  const mod = await import("./overview");
  return { mod, capture };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("getDailySummary", () => {
  it("returns rows from dashboard_daily_summary ordered by day", async () => {
    const rows = [
      { day: "2026-05-01", revenue_usd: 100, margin_usd: 40 },
      { day: "2026-05-02", revenue_usd: 200, margin_usd: 80 },
    ];
    const { mod, capture } = await loadModule({ dashboard_daily_summary: { rows } });

    const result = await mod.getDailySummary(7);

    expect(result).toEqual(rows);
    expect(capture.selects[0].table).toBe("dashboard_daily_summary");
  });
});

describe("getKpis", () => {
  it("aggregates the daily summary rows into a single totals object", async () => {
    const rows = [
      {
        day: "2026-05-01",
        revenue_usd: 100,
        margin_usd: 40,
        order_count: 4,
        listings_published: 1,
        designs: 2,
        briefs: 3,
        fal_spend_usd: 0.5,
        anthropic_spend_usd: 1.25,
        etsy_fees_usd: 7,
      },
      {
        day: "2026-05-02",
        revenue_usd: 200,
        margin_usd: 80,
        order_count: 8,
        listings_published: 2,
        designs: 3,
        briefs: 4,
        fal_spend_usd: 0.75,
        anthropic_spend_usd: 1.25,
        etsy_fees_usd: 14,
      },
    ];
    const { mod } = await loadModule({ dashboard_daily_summary: { rows } });

    const kpis = await mod.getKpis(7);

    expect(kpis).toEqual({
      windowDays: 7,
      revenue_usd: 300,
      margin_usd: 120,
      order_count: 12,
      listings_published: 3,
      designs: 5,
      briefs: 7,
      fal_spend_usd: 1.25,
      anthropic_spend_usd: 2.5,
      etsy_fees_usd: 21,
    });
  });

  it("returns zero KPIs when there are no rows", async () => {
    const { mod } = await loadModule({ dashboard_daily_summary: { rows: [] } });

    const kpis = await mod.getKpis(30);

    expect(kpis.windowDays).toBe(30);
    expect(kpis.revenue_usd).toBe(0);
    expect(kpis.order_count).toBe(0);
  });
});

describe("getPipelineHealth", () => {
  it("returns one entry per agent and sums counts into total", async () => {
    const { mod } = await loadModule({
      trend_briefs: { count: 2 },
      design_packages: { count: 3 },
      listings: { count: 1 },
      orders: { count: 5 },
    });

    const health = await mod.getPipelineHealth();

    expect(health.map((h) => h.agent)).toEqual(["scout", "design", "listing", "ledger"]);
    // 4 statuses × count=2 → total=8 for scout
    expect(health.find((h) => h.agent === "scout")?.total).toBe(8);
    // 5 statuses × count=1 → total=5 for listing
    expect(health.find((h) => h.agent === "listing")?.total).toBe(5);
    // ledger queries 2 statuses (logged, error) × count=5 → total=10
    expect(health.find((h) => h.agent === "ledger")?.total).toBe(10);
  });
});

describe("getRecentErrors", () => {
  it("combines error rows from all 4 source tables and sorts by updated_at desc", async () => {
    const { mod } = await loadModule({
      trend_briefs: {
        rows: [{ id: "b1", updated_at: "2026-05-10T00:00:00Z", error_message: "scout err" }],
      },
      design_packages: {
        rows: [{ id: "d1", updated_at: "2026-05-12T00:00:00Z", error_message: "design err" }],
      },
      listings: {
        rows: [{ id: "l1", updated_at: "2026-05-11T00:00:00Z", error_message: "listing err" }],
      },
      orders: {
        rows: [{ id: "o1", updated_at: "2026-05-09T00:00:00Z", error_message: "ledger err" }],
      },
    });

    const errs = await mod.getRecentErrors(10);

    // sorted newest-first
    expect(errs.map((e) => e.source)).toEqual([
      "design_packages",
      "listings",
      "trend_briefs",
      "orders",
    ]);
    // listing source uses /listings/<id> href, others use list pages
    expect(errs.find((e) => e.source === "listings")?.href).toBe("/listings/l1");
    expect(errs.find((e) => e.source === "trend_briefs")?.href).toBe("/scout");
  });
});

describe("getAllErrors", () => {
  it("returns rows from all four tables with correct shape", async () => {
    const { mod } = await loadModule({
      trend_briefs: {
        rows: [
          {
            id: "b1",
            updated_at: "2026-05-10T00:00:00Z",
            error_message: "scout err",
            retry_count: 1,
            niche: "dog portraits",
          },
        ],
      },
      design_packages: {
        rows: [
          {
            id: "d1",
            updated_at: "2026-05-12T00:00:00Z",
            error_message: "design err",
            retry_count: 2,
          },
        ],
      },
      listings: {
        rows: [
          {
            id: "l1",
            updated_at: "2026-05-11T00:00:00Z",
            error_message: "listing err",
            retry_count: 0,
            title: "Cool Dog Tee",
          },
        ],
      },
      orders: {
        rows: [
          {
            id: "o1",
            updated_at: "2026-05-09T00:00:00Z",
            error_message: "ledger err",
            retry_count: 0,
          },
        ],
      },
    });

    const errs = await mod.getAllErrors();

    // Should have one row per source (4 total), sorted newest-first.
    expect(errs).toHaveLength(4);
    expect(errs.map((e) => e.source)).toEqual([
      "design_packages",
      "listings",
      "trend_briefs",
      "orders",
    ]);
  });

  it("marks orders as requeueable:false and the rest as requeueable:true", async () => {
    const { mod } = await loadModule({
      trend_briefs: {
        rows: [
          { id: "b1", updated_at: "2026-05-10T00:00:00Z", error_message: null, retry_count: 0, niche: "cats" },
        ],
      },
      design_packages: {
        rows: [
          { id: "d1", updated_at: "2026-05-11T00:00:00Z", error_message: null, retry_count: 0 },
        ],
      },
      listings: {
        rows: [
          { id: "l1", updated_at: "2026-05-09T00:00:00Z", error_message: null, retry_count: 0, title: "Tee" },
        ],
      },
      orders: {
        rows: [
          { id: "o1", updated_at: "2026-05-08T00:00:00Z", error_message: null, retry_count: 0 },
        ],
      },
    });

    const errs = await mod.getAllErrors();

    expect(errs.find((e) => e.source === "orders")?.requeueable).toBe(false);
    expect(errs.find((e) => e.source === "trend_briefs")?.requeueable).toBe(true);
    expect(errs.find((e) => e.source === "design_packages")?.requeueable).toBe(true);
    expect(errs.find((e) => e.source === "listings")?.requeueable).toBe(true);
  });

  it("extracts context from niche (trend_briefs) and title (listings)", async () => {
    const { mod } = await loadModule({
      trend_briefs: {
        rows: [
          { id: "b1", updated_at: "2026-05-10T00:00:00Z", error_message: null, retry_count: 0, niche: "dog portraits" },
        ],
      },
      design_packages: { rows: [] },
      listings: {
        rows: [
          { id: "l1", updated_at: "2026-05-09T00:00:00Z", error_message: null, retry_count: 0, title: "Cool Dog Tee" },
        ],
      },
      orders: { rows: [] },
    });

    const errs = await mod.getAllErrors();

    expect(errs.find((e) => e.source === "trend_briefs")?.context).toBe("dog portraits");
    expect(errs.find((e) => e.source === "listings")?.context).toBe("Cool Dog Tee");
  });

  it("leaves context null for design_packages and orders", async () => {
    const { mod } = await loadModule({
      trend_briefs: { rows: [] },
      design_packages: {
        rows: [
          { id: "d1", updated_at: "2026-05-11T00:00:00Z", error_message: null, retry_count: 0 },
        ],
      },
      listings: { rows: [] },
      orders: {
        rows: [
          { id: "o1", updated_at: "2026-05-10T00:00:00Z", error_message: null, retry_count: 0 },
        ],
      },
    });

    const errs = await mod.getAllErrors();

    expect(errs.find((e) => e.source === "design_packages")?.context).toBeNull();
    expect(errs.find((e) => e.source === "orders")?.context).toBeNull();
  });

  it("tolerates a per-table query error and still returns rows from healthy tables", async () => {
    const { mod } = await loadModule({
      trend_briefs: { selectError: { message: "DB offline" } },
      design_packages: {
        rows: [
          { id: "d1", updated_at: "2026-05-11T00:00:00Z", error_message: "oops", retry_count: 1 },
        ],
      },
      listings: { rows: [] },
      orders: { rows: [] },
    });

    const errs = await mod.getAllErrors();

    // trend_briefs errored out — should still get the design_packages row.
    expect(errs.some((e) => e.source === "design_packages")).toBe(true);
    expect(errs.every((e) => e.source !== "trend_briefs")).toBe(true);
  });
});

describe("getRuntimeFlags", () => {
  it("returns rows from runtime_flags ordered by key", async () => {
    const flags = [
      { key: "auto_publish", value: false },
      { key: "vision_enabled", value: true },
    ];
    const { mod, capture } = await loadModule({ runtime_flags: { rows: flags } });

    const result = await mod.getRuntimeFlags();

    expect(result).toEqual(flags);
    expect(capture.selects[0].table).toBe("runtime_flags");
  });
});

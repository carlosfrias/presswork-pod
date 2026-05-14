import { describe, it, expect, vi } from "vitest";
import { makeSupabaseMock, type SupabaseMockOpts } from "@/tests/helpers/supabase-mock";

async function loadModule(opts: SupabaseMockOpts) {
  const { client, capture } = makeSupabaseMock(opts);
  vi.doMock("@/lib/supabase/server", () => ({ serviceClient: () => client }));
  vi.resetModules();
  const mod = await import("./ledger");
  return { mod, capture };
}

describe("getLedgerKpis", () => {
  it("sums logged orders and counts errored ones separately", async () => {
    const orders = [
      {
        status: "logged",
        sale_price_usd: 25,
        margin_usd: 9,
        etsy_fees_usd: 2.5,
        print_cost_usd: 13,
      },
      {
        status: "logged",
        sale_price_usd: 30,
        margin_usd: 11,
        etsy_fees_usd: 3,
        print_cost_usd: 15,
      },
      {
        status: "error",
        sale_price_usd: null,
        margin_usd: null,
        etsy_fees_usd: null,
        print_cost_usd: null,
      },
    ];
    const { mod } = await loadModule({ orders: { rows: orders } });

    const kpis = await mod.getLedgerKpis(30);

    expect(kpis.windowDays).toBe(30);
    expect(kpis.order_count).toBe(2);
    expect(kpis.error_count).toBe(1);
    expect(kpis.revenue_usd).toBe(55);
    expect(kpis.margin_usd).toBe(20);
    expect(kpis.etsy_fees_usd).toBe(5.5);
    expect(kpis.print_cost_usd).toBe(28);
  });
});

describe("getRecentOrders", () => {
  it("flattens the listings join into listing_title and listing_etsy_id", async () => {
    const rows = [
      {
        id: "o1",
        sale_price_usd: 25,
        listings: { title: "Cat Tee", etsy_listing_id: 9001 },
      },
      {
        id: "o2",
        sale_price_usd: 30,
        listings: null,
      },
    ];
    const { mod } = await loadModule({ orders: { rows } });

    const result = await mod.getRecentOrders(30);

    expect(result[0].listing_title).toBe("Cat Tee");
    expect(result[0].listing_etsy_id).toBe(9001);
    expect(result[1].listing_title).toBeNull();
  });
});

describe("getMarginDistribution", () => {
  it("buckets margins into the canonical 6-bucket histogram", async () => {
    const rows = [
      { margin_usd: -1 },
      { margin_usd: 1 },
      { margin_usd: 3 },
      { margin_usd: 7 },
      { margin_usd: 10 },
      { margin_usd: 20 },
      { margin_usd: 25 },
    ];
    const { mod } = await loadModule({ orders: { rows } });

    const buckets = await mod.getMarginDistribution(90);

    expect(buckets.map((b) => b.bucket)).toEqual([
      "< $0",
      "$0–2",
      "$2–5",
      "$5–8",
      "$8–12",
      "$12+",
    ]);
    expect(buckets.find((b) => b.bucket === "< $0")?.count).toBe(1);
    expect(buckets.find((b) => b.bucket === "$0–2")?.count).toBe(1);
    expect(buckets.find((b) => b.bucket === "$2–5")?.count).toBe(1);
    expect(buckets.find((b) => b.bucket === "$5–8")?.count).toBe(1);
    expect(buckets.find((b) => b.bucket === "$8–12")?.count).toBe(1);
    expect(buckets.find((b) => b.bucket === "$12+")?.count).toBe(2);
  });

  it("returns [] when no margins recorded", async () => {
    const { mod } = await loadModule({ orders: { rows: [] } });

    expect(await mod.getMarginDistribution(90)).toEqual([]);
  });
});

describe("getTopListings", () => {
  it("aggregates orders by listing_id, sorts by revenue desc", async () => {
    const rows = [
      {
        listing_id: "l1",
        sale_price_usd: 25,
        margin_usd: 9,
        listings: { title: "Cat Tee", etsy_listing_id: 9001 },
      },
      {
        listing_id: "l1",
        sale_price_usd: 25,
        margin_usd: 9,
        listings: { title: "Cat Tee", etsy_listing_id: 9001 },
      },
      {
        listing_id: "l2",
        sale_price_usd: 30,
        margin_usd: 11,
        listings: { title: "Dog Tee", etsy_listing_id: 9002 },
      },
    ];
    const { mod } = await loadModule({ orders: { rows } });

    const top = await mod.getTopListings(10, 30);

    // l1 has 2 orders × $25 = $50 → ranks higher than l2's single $30
    expect(top[0].listing_id).toBe("l1");
    expect(top[0].order_count).toBe(2);
    expect(top[0].revenue_usd).toBe(50);
    expect(top[1].listing_id).toBe("l2");
  });
});

describe("getBelowThresholdOrders", () => {
  it("returns orders flattened with listing info", async () => {
    const rows = [
      {
        id: "o1",
        margin_usd: 1.5,
        listings: { title: "Cat Tee", etsy_listing_id: 9001 },
      },
    ];
    const { mod } = await loadModule({ orders: { rows } });

    const result = await mod.getBelowThresholdOrders(5);

    expect(result[0].listing_title).toBe("Cat Tee");
    expect(result[0].margin_usd).toBe(1.5);
  });
});

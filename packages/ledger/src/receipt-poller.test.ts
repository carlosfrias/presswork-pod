import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const validEnv = {
  ANTHROPIC_API_KEY: "sk-ant-test",
  ETSY_API_KEY: "etsy-key",
  ETSY_API_SECRET: "etsy-secret",
  ETSY_SHOP_ID: "99",
  ETSY_ACCESS_TOKEN: "access-token",
  ETSY_REFRESH_TOKEN: "refresh-token",
  ETSY_SHIPPING_PROFILE_ID: "99",
  ETSY_PRODUCTION_PARTNER_ID: "999001",
  ETSY_READINESS_STATE_ID: "1",
  FAL_KEY: "fal-key",
  PRINTIFY_API_TOKEN: "printify-token",
  PRINTIFY_SHOP_ID: "shop-1",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  RESEND_API_KEY: "resend-key",
  ALERT_EMAIL: "alert@example.com",
  SLACK_WEBHOOK_URL: "https://hooks.slack.com/test",
  NODE_ENV: "test",
  LOG_LEVEL: "info",
};

const BASE_RECEIPT = {
  receipt_id: 42,
  buyer_user_id: 1,
  buyer_email: "buyer@example.com",
  name: "Jane Doe",
  first_line: "123 Main St",
  city: "Portland",
  state: "OR",
  zip: "97201",
  country_iso: "US",
  grandtotal: { amount: 2499, divisor: 100, currency_code: "USD" },
  transactions: [
    { listing_id: 555, quantity: 1, price: { amount: 2499, divisor: 100, currency_code: "USD" } },
  ],
};

const LISTING_ROW = { design_package_id: "design-uuid-1" };
const DESIGN_ROW = { printify_blueprint_id: 6 };

interface MockOptions {
  insertError?: { code?: string; message: string } | null;
  listingRow?: unknown;
  designRow?: unknown;
}

function makeDbMock(opts: MockOptions = {}) {
  const o = {
    insertError: null,
    listingRow: LISTING_ROW,
    designRow: DESIGN_ROW,
    ...opts,
  };

  const insertCalls: Array<Record<string, unknown>> = [];
  const insertMock = vi.fn().mockImplementation((data: Record<string, unknown>) => {
    insertCalls.push(data);
    return Promise.resolve({ error: o.insertError });
  });

  const fromMock = vi.fn((table: string) => {
    if (table === "orders") {
      return { insert: insertMock };
    }
    if (table === "listings") {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: o.listingRow, error: null }),
          }),
        }),
      };
    }
    if (table === "design_packages") {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: o.designRow, error: null }),
          }),
        }),
      };
    }
    return {};
  });

  return { from: fromMock, insertMock, insertCalls };
}

describe("pollReceipts (ledger)", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, validEnv);
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("logs a fresh receipt with full economics", async () => {
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      listReceipts: vi.fn().mockResolvedValue([BASE_RECEIPT]),
      notifySlack: vi.fn(),
    }));

    const { pollReceipts } = await import("./receipt-poller.js");
    const db = makeDbMock();
    const result = await pollReceipts({ from: db.from } as never);

    expect(result).toEqual({ scanned: 1, logged: 1, duplicate: 0, errored: 0 });
    expect(db.insertCalls).toHaveLength(1);
    const row = db.insertCalls[0]!;
    expect(row["etsy_order_id"]).toBe("42");
    expect(row["status"]).toBe("logged");
    expect(row["sale_price"]).toBeCloseTo(24.99, 2);
    expect(row["sale_price_usd"]).toBeCloseTo(24.99, 2);
    expect(row["currency_code"]).toBe("USD");
    expect(row["print_cost_usd"]).toBe(8.5);
    expect(row["buyer_country"]).toBe("US");
    expect(row["etsy_fees_usd"]).toBeGreaterThan(0);
  });

  it("treats a unique-constraint violation as a duplicate (idempotency)", async () => {
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      listReceipts: vi.fn().mockResolvedValue([BASE_RECEIPT]),
      notifySlack: vi.fn(),
    }));

    const { pollReceipts } = await import("./receipt-poller.js");
    const db = makeDbMock({
      insertError: { code: "23505", message: "duplicate key" },
    });
    const result = await pollReceipts({ from: db.from } as never);

    expect(result).toEqual({ scanned: 1, logged: 0, duplicate: 1, errored: 0 });
  });

  it("logs the row with NULL print_cost when listing is not in DB", async () => {
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      listReceipts: vi.fn().mockResolvedValue([BASE_RECEIPT]),
      notifySlack: vi.fn(),
    }));

    const { pollReceipts } = await import("./receipt-poller.js");
    const db = makeDbMock({ listingRow: null });
    const result = await pollReceipts({ from: db.from } as never);

    expect(result.logged).toBe(1);
    const row = db.insertCalls[0]!;
    expect(row["print_cost_usd"]).toBeNull();
    expect(row["sale_price_usd"]).toBeCloseTo(24.99, 2);
  });

  it("normalizes non-USD receipts to USD on sale_price_usd", async () => {
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      listReceipts: vi.fn().mockResolvedValue([
        {
          ...BASE_RECEIPT,
          grandtotal: { amount: 2499, divisor: 100, currency_code: "EUR" },
        },
      ]),
      notifySlack: vi.fn(),
    }));

    const { pollReceipts } = await import("./receipt-poller.js");
    const db = makeDbMock();
    await pollReceipts({ from: db.from } as never);

    const row = db.insertCalls[0]!;
    expect(row["currency_code"]).toBe("EUR");
    expect(row["sale_price"]).toBeCloseTo(24.99, 2);
    expect(Number(row["sale_price_usd"])).toBeGreaterThan(24.99);
  });

  it("fires a Slack warning when computed margin drops below threshold", async () => {
    const slack = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      listReceipts: vi.fn().mockResolvedValue([
        {
          ...BASE_RECEIPT,
          // $12 sale → fees ~$1.59, print cost $8.50 → margin ~$1.91 (< $5)
          grandtotal: { amount: 1200, divisor: 100, currency_code: "USD" },
        },
      ]),
      notifySlack: slack,
    }));

    const { pollReceipts } = await import("./receipt-poller.js");
    const db = makeDbMock();
    await pollReceipts({ from: db.from } as never);

    expect(slack).toHaveBeenCalledWith(
      expect.stringContaining("Low margin"),
      { severity: "warn" }
    );
  });

});

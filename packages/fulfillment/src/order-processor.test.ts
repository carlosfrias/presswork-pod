import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

const validEnv = {
  ANTHROPIC_API_KEY: "sk-ant-test",
  ETSY_API_KEY: "etsy-key",
  ETSY_API_SECRET: "etsy-secret",
  ETSY_SHOP_ID: "99",
  ETSY_ACCESS_TOKEN: "access-token",
  ETSY_REFRESH_TOKEN: "refresh-token",
  ETSY_SHIPPING_PROFILE_ID: "99",
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
  HUMAN_REVIEW_ENABLED: "true",
};

const RECEIPT = {
  receipt_id: 42,
  buyer_user_id: 1,
  buyer_email: "buyer@example.com",
  name: "Jane Doe",
  first_line: "123 Main St",
  second_line: null,
  city: "Portland",
  state: "OR",
  zip: "97201",
  country_iso: "US",
  grandtotal: { amount: 2499, divisor: 100, currency_code: "USD" },
  transactions: [{ listing_id: 555, quantity: 1, price: { amount: 2499, divisor: 100, currency_code: "USD" } }],
};

const LISTING_ROW = { id: "listing-uuid-1", design_package_id: "design-uuid-1" };
const DESIGN_ROW = {
  image_url: "https://cdn.supabase.co/design.png",
  printify_blueprint_id: 6,
  printify_variant_ids: [101],
};

// Build a chainable Supabase mock
function makeDbMock(overrides?: {
  insertError?: { code?: string; message: string } | null;
  insertRows?: Array<{ id: string }> | null;
  listingRow?: unknown;
  listingError?: unknown;
  designRow?: unknown;
  designError?: unknown;
  orderRetryCount?: number;
}) {
  const opts = {
    insertError: null,
    insertRows: [{ id: "order-uuid-1" }],
    listingRow: LISTING_ROW,
    listingError: null,
    designRow: DESIGN_ROW,
    designError: null,
    orderRetryCount: 0,
    ...overrides,
  };

  const updateMock = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });

  const fromMock = vi.fn((table: string) => {
    if (table === "orders") {
      return {
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            returns: vi.fn().mockResolvedValue({ data: opts.insertRows, error: opts.insertError }),
          }),
        }),
        update: updateMock,
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { retry_count: opts.orderRetryCount },
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === "listings") {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: opts.listingRow,
              error: opts.listingError,
            }),
          }),
        }),
      };
    }
    if (table === "design_packages") {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: opts.designRow,
              error: opts.designError,
            }),
          }),
        }),
      };
    }
    return {};
  });

  return { from: fromMock, updateMock };
}

const server = setupServer();
beforeEach(() => server.listen({ onUnhandledRequest: "warn" }));
afterEach(() => { server.resetHandlers(); server.close(); });

describe("processOrder", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, validEnv);
  });

  afterEach(() => { process.env = savedEnv; });

  it("happy path: creates order, returns 'created', row reaches submitted", async () => {
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      getReceipt: vi.fn().mockResolvedValue(RECEIPT),
      notifySlack: vi.fn(),
    }));

    server.use(
      http.post("https://api.printify.com/v1/shops/shop-1/orders.json", () =>
        HttpResponse.json({ id: "pf-order-1" })
      )
    );

    const { processOrder } = await import("./order-processor.js");
    const db = makeDbMock();
    const result = await processOrder({ from: db.from } as never, "42");

    expect(result.outcome).toBe("created");
    expect(result.orderId).toBe("order-uuid-1");
    // last update should set status=submitted with printify_order_id
    const updateCalls = db.updateMock.mock.calls;
    const lastCall = updateCalls[updateCalls.length - 1]?.[0] as Record<string, unknown>;
    expect(lastCall?.["status"]).toBe("submitted");
    expect(lastCall?.["printify_order_id"]).toBe("pf-order-1");
  });

  it("idempotency: returns 'duplicate' when unique constraint violated", async () => {
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      getReceipt: vi.fn(),
      notifySlack: vi.fn(),
    }));

    const { processOrder } = await import("./order-processor.js");
    const db = makeDbMock({
      insertError: { code: "23505", message: "duplicate key" },
      insertRows: null,
    });
    const result = await processOrder({ from: db.from } as never, "42");
    expect(result.outcome).toBe("duplicate");
  });

  it("idempotency: returns 'duplicate' when no rows returned (concurrent insert)", async () => {
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      getReceipt: vi.fn(),
      notifySlack: vi.fn(),
    }));

    const { processOrder } = await import("./order-processor.js");
    const db = makeDbMock({ insertRows: [] });
    const result = await processOrder({ from: db.from } as never, "42");
    expect(result.outcome).toBe("duplicate");
  });

  it("listing not in DB: row → error, Slack alert fired", async () => {
    const slackMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      getReceipt: vi.fn().mockResolvedValue(RECEIPT),
      notifySlack: slackMock,
    }));

    const { processOrder } = await import("./order-processor.js");
    const db = makeDbMock({ listingRow: null });
    const result = await processOrder({ from: db.from } as never, "42");

    expect(result.outcome).toBe("error");
    expect(slackMock).toHaveBeenCalledWith(expect.stringContaining("555"), { severity: "error" });
  });

  it("Printify 5xx: retry_count=1, status returns to 'received' (retry budget not exhausted)", async () => {
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      getReceipt: vi.fn().mockResolvedValue(RECEIPT),
      notifySlack: vi.fn(),
    }));

    server.use(
      http.post("https://api.printify.com/v1/shops/shop-1/orders.json", () =>
        new HttpResponse("server error", { status: 500 })
      )
    );

    const { processOrder } = await import("./order-processor.js");
    const db = makeDbMock({ orderRetryCount: 0 });
    const result = await processOrder({ from: db.from } as never, "42");

    expect(result.outcome).toBe("error");
    const updateCalls = db.updateMock.mock.calls;
    const errorUpdate = updateCalls.find((c) => {
      const arg = c[0] as Record<string, unknown>;
      return arg?.["retry_count"] === 1;
    });
    expect(errorUpdate).toBeDefined();
    const arg = errorUpdate![0] as Record<string, unknown>;
    expect(arg?.["status"]).toBe("received");
  }, 20000);

  it("third Printify failure: row stays at error, Slack alert fired", async () => {
    const slackMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      getReceipt: vi.fn().mockResolvedValue(RECEIPT),
      notifySlack: slackMock,
    }));

    server.use(
      http.post("https://api.printify.com/v1/shops/shop-1/orders.json", () =>
        new HttpResponse("server error", { status: 500 })
      )
    );

    const { processOrder } = await import("./order-processor.js");
    // Simulate retry_count already at 2 (this is the 3rd attempt)
    const db = makeDbMock({ orderRetryCount: 2 });
    const result = await processOrder({ from: db.from } as never, "42");

    expect(result.outcome).toBe("error");
    expect(slackMock).toHaveBeenCalledWith(
      expect.stringContaining("order-uuid-1"),
      { severity: "error" }
    );
    const updateCalls = db.updateMock.mock.calls;
    const errorUpdate = updateCalls.find((c) => {
      const arg = c[0] as Record<string, unknown>;
      return (arg?.["retry_count"] as number) >= 3;
    });
    const arg = errorUpdate![0] as Record<string, unknown>;
    expect(arg?.["status"]).toBe("error");
  }, 20000);
});

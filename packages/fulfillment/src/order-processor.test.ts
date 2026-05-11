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
  printify_variants: null,
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
  existingOrderRow?: { id: string; status: string; printify_order_id: string | null } | null;
}) {
  const opts = {
    insertError: null,
    insertRows: [{ id: "order-uuid-1" }],
    listingRow: LISTING_ROW,
    listingError: null,
    designRow: DESIGN_ROW,
    designError: null,
    orderRetryCount: 0,
    existingOrderRow: null,
    ...overrides,
  };

  // Capture both the data passed to update() and any subsequent .eq() filters,
  // so tests can assert on the conditional UPDATE ... WHERE status='received'
  // guard added for the concurrency bug.
  type UpdateCall = { data: Record<string, unknown>; filters: Array<[string, unknown]> };
  const updateCalls: UpdateCall[] = [];
  const updateMock = vi.fn().mockImplementation((data: Record<string, unknown>) => {
    const call: UpdateCall = { data, filters: [] };
    updateCalls.push(call);
    const chain = {
      eq: vi.fn().mockImplementation((col: string, val: unknown) => {
        call.filters.push([col, val]);
        return chain;
      }),
    };
    return chain;
  });

  const fromMock = vi.fn((table: string) => {
    if (table === "orders") {
      return {
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            returns: vi.fn().mockResolvedValue({ data: opts.insertRows, error: opts.insertError }),
          }),
        }),
        update: updateMock,
        select: vi.fn().mockImplementation((cols: string) => {
          // recoverDuplicateRow selects id, status, printify_order_id
          if (cols.includes("printify_order_id")) {
            return {
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: opts.existingOrderRow,
                  error: null,
                }),
              }),
            };
          }
          // Default: catch-block retry_count read
          return {
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { retry_count: opts.orderRetryCount },
                error: null,
              }),
            }),
          };
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

  return { from: fromMock, updateMock, updateCalls };
}

const server = setupServer();
beforeEach(() => server.listen({ onUnhandledRequest: "warn" }));
afterEach(() => { server.resetHandlers(); server.close(); });

describe("splitBuyerName (bug #27)", () => {
  it("splits a two-word name into first + last", async () => {
    const { splitBuyerName } = await import("./order-processor.js");
    expect(splitBuyerName("Jane Doe")).toEqual({ firstName: "Jane", lastName: "Doe" });
  });

  it("treats trailing token as last, rest as first (Mary Anne Smith)", async () => {
    const { splitBuyerName } = await import("./order-processor.js");
    expect(splitBuyerName("Mary Anne Smith")).toEqual({
      firstName: "Mary Anne",
      lastName: "Smith",
    });
  });

  it("single-word name duplicates into both fields (Cher)", async () => {
    const { splitBuyerName } = await import("./order-processor.js");
    expect(splitBuyerName("Cher")).toEqual({ firstName: "Cher", lastName: "Cher" });
  });

  it("preserves Unicode names", async () => {
    const { splitBuyerName } = await import("./order-processor.js");
    expect(splitBuyerName("José García")).toEqual({
      firstName: "José",
      lastName: "García",
    });
  });

  it("preserves hyphenated last names", async () => {
    const { splitBuyerName } = await import("./order-processor.js");
    expect(splitBuyerName("Mary Smith-Jones")).toEqual({
      firstName: "Mary",
      lastName: "Smith-Jones",
    });
  });

  it("collapses extra whitespace", async () => {
    const { splitBuyerName } = await import("./order-processor.js");
    expect(splitBuyerName("  Jane   Doe  ")).toEqual({
      firstName: "Jane",
      lastName: "Doe",
    });
  });
});

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

  it("persists buyer currency and normalizes sale_price_usd (bug #28)", async () => {
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      getReceipt: vi.fn().mockResolvedValue({
        ...RECEIPT,
        grandtotal: { amount: 2499, divisor: 100, currency_code: "EUR" },
      }),
      notifySlack: vi.fn(),
    }));

    server.use(
      http.post("https://api.printify.com/v1/shops/shop-1/orders.json", () =>
        HttpResponse.json({ id: "pf-eur-1" })
      )
    );

    const { processOrder } = await import("./order-processor.js");
    const db = makeDbMock();
    await processOrder({ from: db.from } as never, "42");

    const econUpdate = db.updateCalls.find((c) => "sale_price_usd" in c.data);
    expect(econUpdate).toBeDefined();
    // EUR 24.99 → USD via static rate (~$26.99)
    expect(econUpdate!.data.currency_code).toBe("EUR");
    expect(econUpdate!.data.sale_price).toBeCloseTo(24.99, 2);
    expect(Number(econUpdate!.data.sale_price_usd)).toBeGreaterThan(24.99);
  });

  it("recovers from a crash between INSERT and Printify (bug #5)", async () => {
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      getReceipt: vi.fn().mockResolvedValue(RECEIPT),
      notifySlack: vi.fn(),
    }));

    server.use(
      http.post("https://api.printify.com/v1/shops/shop-1/orders.json", () =>
        HttpResponse.json({ id: "pf-order-recovered" })
      )
    );

    const { processOrder } = await import("./order-processor.js");
    // Simulate: unique violation on INSERT, but the existing row is still
    // 'received' with no printify_order_id — process should recover.
    const db = makeDbMock({
      insertError: { code: "23505", message: "duplicate key value violates unique constraint" },
      insertRows: null,
      existingOrderRow: {
        id: "order-uuid-recovered",
        status: "received",
        printify_order_id: null,
      },
    });

    const result = await processOrder({ from: db.from } as never, "42");
    expect(result.outcome).toBe("created");
    expect(result.orderId).toBe("order-uuid-recovered");
  });

  it("returns 'duplicate' when existing row already has a printify_order_id (no recovery)", async () => {
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      getReceipt: vi.fn(),
      notifySlack: vi.fn(),
    }));

    const { processOrder } = await import("./order-processor.js");
    const db = makeDbMock({
      insertError: { code: "23505", message: "duplicate key" },
      insertRows: null,
      existingOrderRow: {
        id: "order-uuid-1",
        status: "submitted",
        printify_order_id: "pf-already-submitted",
      },
    });

    const result = await processOrder({ from: db.from } as never, "42");
    expect(result.outcome).toBe("duplicate");
  });

  it("rejects insert errors that are NOT unique-violation (no substring matching)", async () => {
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      getReceipt: vi.fn(),
      notifySlack: vi.fn(),
    }));

    const { processOrder } = await import("./order-processor.js");
    // Some other Postgres error with 'duplicate key' literally in the message
    // (this is exactly what substring matching would have miscategorised).
    const db = makeDbMock({
      insertError: { code: "42501", message: "permission denied: duplicate key check failed" },
      insertRows: null,
    });

    const result = await processOrder({ from: db.from } as never, "42");
    expect(result.outcome).toBe("error");
    expect(result.error).toContain("permission denied");
  });

  it("resolves variant_id per transaction using printify_variants map (bug #7)", async () => {
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      getReceipt: vi.fn().mockResolvedValue({
        ...RECEIPT,
        transactions: [
          {
            listing_id: 555,
            quantity: 1,
            price: { amount: 2499, divisor: 100, currency_code: "USD" },
            variations: [
              { formatted_name: "Size", formatted_value: "M" },
              { formatted_name: "Color", formatted_value: "Red" },
            ],
          },
        ],
      }),
      notifySlack: vi.fn(),
    }));

    const printifyPostBody = vi.fn();
    server.use(
      http.post("https://api.printify.com/v1/shops/shop-1/orders.json", async ({ request }) => {
        printifyPostBody(await request.json());
        return HttpResponse.json({ id: "pf-order-1" });
      })
    );

    const { processOrder } = await import("./order-processor.js");
    const db = makeDbMock({
      designRow: {
        image_url: "https://cdn.supabase.co/design.png",
        printify_blueprint_id: 6,
        printify_variant_ids: [101, 102, 103],
        printify_variants: [
          { id: 101, values: ["s", "blue"] },
          { id: 102, values: ["m", "red"] }, // <-- should match
          { id: 103, values: ["l", "black"] },
        ],
      },
    });
    const result = await processOrder({ from: db.from } as never, "42");

    expect(result.outcome).toBe("created");
    expect(printifyPostBody).toHaveBeenCalledTimes(1);
    const body = printifyPostBody.mock.calls[0]?.[0] as {
      line_items: Array<{ variant_id: number }>;
    };
    expect(body.line_items[0]?.variant_id).toBe(102);
  });

  it("rejects to error when variations don't match any printify_variants (bug #7)", async () => {
    const slackMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      getReceipt: vi.fn().mockResolvedValue({
        ...RECEIPT,
        transactions: [
          {
            listing_id: 555,
            quantity: 1,
            price: { amount: 2499, divisor: 100, currency_code: "USD" },
            variations: [{ formatted_name: "Size", formatted_value: "XXL" }],
          },
        ],
      }),
      notifySlack: slackMock,
    }));

    server.use(
      http.post("https://api.printify.com/v1/shops/shop-1/orders.json", () =>
        HttpResponse.json({ id: "pf-should-not-be-called" })
      )
    );

    const { processOrder } = await import("./order-processor.js");
    const db = makeDbMock({
      designRow: {
        image_url: "https://cdn.supabase.co/design.png",
        printify_blueprint_id: 6,
        printify_variant_ids: [101, 102],
        printify_variants: [
          { id: 101, values: ["s"] },
          { id: 102, values: ["m"] },
        ],
      },
    });
    const result = await processOrder({ from: db.from } as never, "42");

    expect(result.outcome).toBe("error");
    expect(result.error).toMatch(/no printify variant matches/i);
    expect(slackMock).toHaveBeenCalled();
  });

  it("falls back to printify_variant_ids[0] when receipt has no variations (single-variant blueprint)", async () => {
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      getReceipt: vi.fn().mockResolvedValue({
        ...RECEIPT,
        transactions: [
          {
            listing_id: 555,
            quantity: 1,
            price: { amount: 2499, divisor: 100, currency_code: "USD" },
            // no variations
          },
        ],
      }),
      notifySlack: vi.fn(),
    }));

    const printifyPostBody = vi.fn();
    server.use(
      http.post("https://api.printify.com/v1/shops/shop-1/orders.json", async ({ request }) => {
        printifyPostBody(await request.json());
        return HttpResponse.json({ id: "pf-order-1" });
      })
    );

    const { processOrder } = await import("./order-processor.js");
    const db = makeDbMock(); // DESIGN_ROW has printify_variants=null
    const result = await processOrder({ from: db.from } as never, "42");

    expect(result.outcome).toBe("created");
    const body = printifyPostBody.mock.calls[0]?.[0] as {
      line_items: Array<{ variant_id: number }>;
    };
    expect(body.line_items[0]?.variant_id).toBe(101);
  });

  it("post-Printify UPDATE includes WHERE status='received' guard (bug #5 race)", async () => {
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
    await processOrder({ from: db.from } as never, "42");

    const submitCall = db.updateCalls.find(
      (c) =>
        c.data["status"] === "submitted" && "printify_order_id" in c.data
    );
    expect(submitCall).toBeDefined();
    // Must filter by both id AND status='received' so a concurrent advance is a no-op.
    expect(submitCall!.filters).toEqual(
      expect.arrayContaining([
        ["id", expect.any(String)],
        ["status", "received"],
      ])
    );
  });

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

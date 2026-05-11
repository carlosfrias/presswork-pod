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

const server = setupServer();
beforeEach(() => server.listen({ onUnhandledRequest: "warn" }));
afterEach(() => { server.resetHandlers(); server.close(); });

function makeDbMock(opts: {
  orders: Array<{
    id: string;
    status?: string;
    printify_order_id: string;
    etsy_order_id: string;
    retry_count: number;
  }>;
}) {
  // Update returns a chain that can take any number of .eq(...) filters and
  // ultimately resolves. Captures the filters for assertions.
  type UpdateCall = { data: Record<string, unknown>; filters: Array<[string, unknown]> };
  const updateCalls: UpdateCall[] = [];
  type Chain = {
    eq: ReturnType<typeof vi.fn>;
    then: (resolve: (v: { error: null }) => void) => void;
  };
  const updateMock = vi.fn().mockImplementation((data: Record<string, unknown>) => {
    const entry: UpdateCall = { data, filters: [] };
    updateCalls.push(entry);
    const chain: Chain = {
      eq: vi.fn(),
      then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
    };
    chain.eq.mockImplementation((col: string, val: unknown) => {
      entry.filters.push([col, val]);
      return chain;
    });
    return chain;
  });

  // Default: orders default to status='submitted' so existing tests behave
  // identically to before. The new shipped+unsent test seeds status='shipped'.
  const ordersWithStatus = opts.orders.map((o) => ({ status: "submitted", ...o }));

  const fromMock = vi.fn(() => ({
    select: vi.fn().mockReturnValue({
      // New code path: .select().or().not() returns rows.
      or: vi.fn().mockReturnValue({
        not: vi.fn().mockResolvedValue({ data: ordersWithStatus, error: null }),
      }),
      // Legacy path retained in case anything still wires through .eq().not().
      eq: vi.fn().mockReturnValue({
        not: vi.fn().mockResolvedValue({ data: ordersWithStatus, error: null }),
      }),
    }),
    update: updateMock,
  }));

  return { from: fromMock, updateMock, updateCalls };
}

describe("pollTracking", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, validEnv);
  });

  afterEach(() => { process.env = savedEnv; });

  it("happy path: 1 shipped + 1 in_production → shipped=1, stillInProgress=1", async () => {
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      getValidAccessToken: vi.fn().mockResolvedValue("token"),
      submitTracking: vi.fn().mockResolvedValue(undefined),
      notifySlack: vi.fn(),
    }));

    server.use(
      http.get("https://api.printify.com/v1/shops/shop-1/orders/pf-1.json", () =>
        HttpResponse.json({
          id: "pf-1",
          status: "shipped",
          shipments: [{ carrier: "USPS", number: "1Z999", url: "https://usps.com/1Z999" }],
        })
      ),
      http.get("https://api.printify.com/v1/shops/shop-1/orders/pf-2.json", () =>
        HttpResponse.json({ id: "pf-2", status: "in_production", shipments: [] })
      )
    );

    const db = makeDbMock({
      orders: [
        { id: "order-1", printify_order_id: "pf-1", etsy_order_id: "receipt-1", retry_count: 0 },
        { id: "order-2", printify_order_id: "pf-2", etsy_order_id: "receipt-2", retry_count: 0 },
      ],
    });

    const { pollTracking } = await import("./tracking-poller.js");
    const stats = await pollTracking({ from: db.from } as never);

    expect(stats.shipped).toBe(1);
    expect(stats.stillInProgress).toBe(1);
    expect(stats.errored).toBe(0);
  });

  it("Etsy submitTracking 4xx: row stays at submitted, retry_count incremented", async () => {
    const submitTrackingMock = vi.fn().mockRejectedValue(new Error("Etsy 404"));
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      getValidAccessToken: vi.fn().mockResolvedValue("token"),
      submitTracking: submitTrackingMock,
      notifySlack: vi.fn(),
    }));

    server.use(
      http.get("https://api.printify.com/v1/shops/shop-1/orders/pf-1.json", () =>
        HttpResponse.json({
          id: "pf-1",
          status: "shipped",
          shipments: [{ carrier: "USPS", number: "1Z999", url: "" }],
        })
      )
    );

    const db = makeDbMock({
      orders: [{ id: "order-1", printify_order_id: "pf-1", etsy_order_id: "receipt-1", retry_count: 0 }],
    });

    const { pollTracking } = await import("./tracking-poller.js");
    const stats = await pollTracking({ from: db.from } as never);

    expect(stats.errored).toBe(1);
    // Verify retry_count was incremented
    const updateArg = db.updateMock.mock.calls.find((c) => {
      const a = c[0] as Record<string, unknown>;
      return typeof a?.["retry_count"] === "number";
    });
    expect(updateArg).toBeDefined();
    const arg = updateArg![0] as Record<string, unknown>;
    expect(arg?.["retry_count"]).toBe(1);
  });

  it("unknown carrier: submitTracking NOT called, Slack warn fired, row still marked shipped", async () => {
    const submitTrackingMock = vi.fn();
    const slackMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      getValidAccessToken: vi.fn().mockResolvedValue("token"),
      submitTracking: submitTrackingMock,
      notifySlack: slackMock,
    }));

    server.use(
      http.get("https://api.printify.com/v1/shops/shop-1/orders/pf-1.json", () =>
        HttpResponse.json({
          id: "pf-1",
          status: "shipped",
          shipments: [{ carrier: "Mystery Carrier LLC", number: "TRACK123", url: "" }],
        })
      )
    );

    const db = makeDbMock({
      orders: [{ id: "order-1", printify_order_id: "pf-1", etsy_order_id: "receipt-1", retry_count: 0 }],
    });

    const { pollTracking } = await import("./tracking-poller.js");
    const stats = await pollTracking({ from: db.from } as never);

    // Tracking was not submitted to Etsy
    expect(submitTrackingMock).not.toHaveBeenCalled();
    // Slack warn was fired
    expect(slackMock).toHaveBeenCalledWith(
      expect.stringContaining("Mystery Carrier LLC"),
      { severity: "warn" }
    );
    // Row is still counted as shipped (DB update happened before normalization)
    expect(stats.shipped).toBe(1);
    expect(stats.errored).toBe(0);
  });

  it("conditional UPDATE includes WHERE status='submitted' (bug #34 race guard)", async () => {
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      getValidAccessToken: vi.fn().mockResolvedValue("token"),
      submitTracking: vi.fn().mockResolvedValue(undefined),
      notifySlack: vi.fn(),
    }));

    server.use(
      http.get("https://api.printify.com/v1/shops/shop-1/orders/pf-1.json", () =>
        HttpResponse.json({
          id: "pf-1",
          status: "shipped",
          shipments: [{ carrier: "USPS", number: "1Z999", url: "" }],
        })
      )
    );

    const db = makeDbMock({
      orders: [
        { id: "order-1", status: "submitted", printify_order_id: "pf-1", etsy_order_id: "receipt-1", retry_count: 0 },
      ],
    });

    const { pollTracking } = await import("./tracking-poller.js");
    await pollTracking({ from: db.from } as never);

    // The flip-to-shipped update must carry both id and status filters.
    const flipCall = db.updateCalls.find((c) => c.data["status"] === "shipped");
    expect(flipCall).toBeDefined();
    expect(flipCall!.filters).toEqual(
      expect.arrayContaining([
        ["id", "order-1"],
        ["status", "submitted"],
      ])
    );
  });

  it("re-submits Etsy tracking for shipped+unsent rows without flipping status (bug #30)", async () => {
    const submitTrackingMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      getValidAccessToken: vi.fn().mockResolvedValue("token"),
      submitTracking: submitTrackingMock,
      notifySlack: vi.fn(),
    }));

    server.use(
      http.get("https://api.printify.com/v1/shops/shop-1/orders/pf-1.json", () =>
        HttpResponse.json({
          id: "pf-1",
          status: "shipped",
          shipments: [{ carrier: "USPS", number: "1Z999", url: "https://usps.com/1Z999" }],
        })
      )
    );

    const db = makeDbMock({
      orders: [
        {
          id: "order-1",
          status: "shipped", // already shipped per the webhook; Etsy submission failed previously
          printify_order_id: "pf-1",
          etsy_order_id: "receipt-1",
          retry_count: 0,
        },
      ],
    });

    const { pollTracking } = await import("./tracking-poller.js");
    const stats = await pollTracking({ from: db.from } as never);

    expect(stats.shipped).toBe(1);
    expect(submitTrackingMock).toHaveBeenCalledTimes(1);

    // No update should write status='shipped' again — row is already there.
    const statusUpdates = db.updateCalls.filter(
      (c) => c.data["status"] === "shipped"
    );
    expect(statusUpdates).toHaveLength(0);

    // But etsy_tracking_submitted_at must be set after the successful PATCH.
    const markUpdates = db.updateCalls.filter(
      (c) => "etsy_tracking_submitted_at" in c.data
    );
    expect(markUpdates).toHaveLength(1);
  });

  it("Printify cancelled status: row → error, Slack alert fired", async () => {
    const slackMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      getValidAccessToken: vi.fn().mockResolvedValue("token"),
      submitTracking: vi.fn(),
      notifySlack: slackMock,
    }));

    server.use(
      http.get("https://api.printify.com/v1/shops/shop-1/orders/pf-1.json", () =>
        HttpResponse.json({ id: "pf-1", status: "cancelled", shipments: [] })
      )
    );

    const db = makeDbMock({
      orders: [{ id: "order-1", printify_order_id: "pf-1", etsy_order_id: "receipt-1", retry_count: 0 }],
    });

    const { pollTracking } = await import("./tracking-poller.js");
    const stats = await pollTracking({ from: db.from } as never);

    expect(stats.errored).toBe(1);
    expect(slackMock).toHaveBeenCalledWith(expect.stringContaining("cancelled"), { severity: "error" });

    const updateArg = db.updateMock.mock.calls.find((c) => {
      const a = c[0] as Record<string, unknown>;
      return a?.["status"] === "error";
    });
    expect(updateArg).toBeDefined();
  });
});

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

const server = setupServer();
beforeEach(() => server.listen({ onUnhandledRequest: "warn" }));
afterEach(() => { server.resetHandlers(); server.close(); });

function makeDbMock(opts: {
  orders: Array<{ id: string; printify_order_id: string; etsy_order_id: string; retry_count: number }>;
}) {
  const updateEq = vi.fn().mockResolvedValue({ error: null });
  const updateMock = vi.fn().mockReturnValue({ eq: updateEq });

  const selectResult = {
    eq: vi.fn().mockReturnValue({
      not: vi.fn().mockResolvedValue({ data: opts.orders, error: null }),
    }),
  };

  const fromMock = vi.fn(() => ({
    select: vi.fn().mockReturnValue(selectResult),
    update: updateMock,
  }));

  return { from: fromMock, updateMock, updateEq };
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

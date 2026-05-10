import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

function makeReceipt(id: number) {
  return {
    receipt_id: id,
    buyer_user_id: 1,
    name: "Jane Doe",
    first_line: "123 Main",
    city: "Portland",
    state: "OR",
    zip: "97201",
    country_iso: "US",
    grandtotal: { amount: 2499, divisor: 100, currency_code: "USD" },
    transactions: [{ listing_id: 555, quantity: 1, price: { amount: 2499, divisor: 100, currency_code: "USD" } }],
  };
}

const server = setupServer();
beforeEach(() => server.listen({ onUnhandledRequest: "warn" }));
afterEach(() => { server.resetHandlers(); server.close(); });

describe("pollReceipts", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, validEnv);
  });

  afterEach(() => { process.env = savedEnv; });

  it("3 receipts, 1 duplicate → scanned=3, processed=2, skipped=1, errored=0", async () => {
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      getValidAccessToken: vi.fn().mockResolvedValue("test-token"),
      listReceipts: vi.fn().mockResolvedValue([
        makeReceipt(1),
        makeReceipt(2),
        makeReceipt(3),
      ]),
    }));

    const processOrderMock = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "created", orderId: "o1" })
      .mockResolvedValueOnce({ outcome: "duplicate" })
      .mockResolvedValueOnce({ outcome: "created", orderId: "o3" });

    const { pollReceipts } = await import("./receipt-poller.js");
    const stats = await pollReceipts({} as never, processOrderMock);

    expect(stats).toEqual({ scanned: 3, processed: 2, skipped: 1, errored: 0 });
    expect(processOrderMock).toHaveBeenCalledTimes(3);
  });

  it("empty receipt list → all zeros, no throw", async () => {
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      listReceipts: vi.fn().mockResolvedValue([]),
    }));

    const processOrderMock = vi.fn();
    const { pollReceipts } = await import("./receipt-poller.js");
    const stats = await pollReceipts({} as never, processOrderMock);

    expect(stats).toEqual({ scanned: 0, processed: 0, skipped: 0, errored: 0 });
    expect(processOrderMock).not.toHaveBeenCalled();
  });

  it("one processOrder throws: rest still processed, errored=1", async () => {
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      listReceipts: vi.fn().mockResolvedValue([makeReceipt(1), makeReceipt(2), makeReceipt(3)]),
    }));

    const processOrderMock = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "created" })
      .mockRejectedValueOnce(new Error("something blew up"))
      .mockResolvedValueOnce({ outcome: "created" });

    const { pollReceipts } = await import("./receipt-poller.js");
    const stats = await pollReceipts({} as never, processOrderMock);

    expect(stats.errored).toBe(1);
    expect(stats.processed).toBe(2);
    expect(processOrderMock).toHaveBeenCalledTimes(3);
  });

  it("listReceipts throws: error propagates out of pollReceipts", async () => {
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      listReceipts: vi.fn().mockRejectedValue(new Error("Etsy 500")),
    }));

    const { pollReceipts } = await import("./receipt-poller.js");
    await expect(pollReceipts({} as never, vi.fn())).rejects.toThrow("Etsy 500");
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

const ORDER_INPUT = {
  etsyReceiptId: "receipt-42",
  lineItems: [{ blueprintId: 6, variantId: 101, imageUrl: "https://cdn.example.com/img.png", quantity: 1 }],
  address: {
    firstName: "Jane",
    lastName: "Doe",
    email: "jane@example.com",
    address1: "123 Main St",
    city: "Portland",
    state: "OR",
    country: "US",
    zip: "97201",
  },
};

const server = setupServer();
beforeEach(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => { server.resetHandlers(); server.close(); });

describe("createOrder", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, validEnv);
  });

  afterEach(() => { process.env = savedEnv; });

  it("happy path: returns printifyOrderId", async () => {
    server.use(
      http.post("https://api.printify.com/v1/shops/shop-1/orders.json", () =>
        HttpResponse.json({ id: "pf-order-1" })
      )
    );
    const { createOrder } = await import("./printify-orders.js");
    const result = await createOrder(ORDER_INPUT);
    expect(result.printifyOrderId).toBe("pf-order-1");
  });

  it("sends label as etsy-{receiptId} and external_id for idempotency", async () => {
    let capturedBody: unknown;
    server.use(
      http.post("https://api.printify.com/v1/shops/shop-1/orders.json", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ id: "pf-order-2" });
      })
    );
    const { createOrder } = await import("./printify-orders.js");
    await createOrder(ORDER_INPUT);
    expect(capturedBody).toMatchObject({
      label: "etsy-receipt-42",
      external_id: "receipt-42",
    });
  });

  it("retries 5xx and eventually succeeds", async () => {
    let attempts = 0;
    server.use(
      http.post("https://api.printify.com/v1/shops/shop-1/orders.json", () => {
        attempts++;
        if (attempts < 3) return new HttpResponse("server error", { status: 500 });
        return HttpResponse.json({ id: "pf-order-3" });
      })
    );
    const { createOrder } = await import("./printify-orders.js");
    const result = await createOrder(ORDER_INPUT);
    expect(result.printifyOrderId).toBe("pf-order-3");
    expect(attempts).toBe(3);
  });

  it("surfaces 4xx immediately without retrying", async () => {
    let attempts = 0;
    server.use(
      http.post("https://api.printify.com/v1/shops/shop-1/orders.json", () => {
        attempts++;
        return new HttpResponse("bad request", { status: 400 });
      })
    );
    const { createOrder } = await import("./printify-orders.js");
    const { PrintifyError } = await import("@presswork/shared");
    await expect(createOrder(ORDER_INPUT)).rejects.toThrow(PrintifyError);
    expect(attempts).toBe(1);
  });
});

describe("getOrder", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, validEnv);
  });

  afterEach(() => { process.env = savedEnv; });

  it("parses 'in_production' status with no tracking", async () => {
    server.use(
      http.get("https://api.printify.com/v1/shops/shop-1/orders/pf-order-1.json", () =>
        HttpResponse.json({ id: "pf-order-1", status: "in_production", shipments: [] })
      )
    );
    const { getOrder } = await import("./printify-orders.js");
    const detail = await getOrder("pf-order-1");
    expect(detail.status).toBe("in_production");
    expect(detail.tracking).toBeUndefined();
  });

  it("parses 'shipped' status with tracking", async () => {
    server.use(
      http.get("https://api.printify.com/v1/shops/shop-1/orders/pf-order-2.json", () =>
        HttpResponse.json({
          id: "pf-order-2",
          status: "shipped",
          shipments: [{ carrier: "USPS", number: "1Z999", url: "https://usps.com/track/1Z999" }],
        })
      )
    );
    const { getOrder } = await import("./printify-orders.js");
    const detail = await getOrder("pf-order-2");
    expect(detail.status).toBe("shipped");
    expect(detail.tracking?.number).toBe("1Z999");
    expect(detail.tracking?.carrier).toBe("USPS");
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createHmac } from "node:crypto";
import { createApp } from "./server.js";

const SECRET = "etsy-secret";
const validEnv = {
  ANTHROPIC_API_KEY: "sk-ant-test",
  ETSY_API_KEY: "etsy-key",
  ETSY_API_SECRET: SECRET,
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

function makePayload(receiptId: number) {
  return Buffer.from(JSON.stringify({ receipt_id: receiptId }));
}

function signPayload(body: Buffer, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

const NOW_TS = String(Math.floor(Date.now() / 1000));

describe("createApp", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    Object.assign(process.env, validEnv);
  });

  afterEach(() => {
    process.env = savedEnv;
    vi.restoreAllMocks();
  });

  it("GET /healthz returns {ok:true}", async () => {
    const processOrder = vi.fn();
    const app = createApp({ db: {} as never, processOrder });
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("valid HMAC → 200, processOrder called with extracted receipt id", async () => {
    const processOrder = vi.fn().mockResolvedValue({ outcome: "created", orderId: "order-1" });
    const app = createApp({ db: {} as never, processOrder });

    const body = makePayload(42);
    const sig = signPayload(body, SECRET);

    const res = await request(app)
      .post("/webhook/etsy-order")
      .set("content-type", "application/octet-stream")
      .set("x-etsy-signature", sig)
      .set("x-etsy-request-timestamp", NOW_TS)
      .send(body);

    expect(res.status).toBe(200);
    expect(processOrder).toHaveBeenCalledOnce();
    expect(processOrder).toHaveBeenCalledWith(expect.anything(), "42");
  });

  it("invalid HMAC → 401, processOrder NOT called", async () => {
    const processOrder = vi.fn();
    const app = createApp({ db: {} as never, processOrder });

    const body = makePayload(42);

    const res = await request(app)
      .post("/webhook/etsy-order")
      .set("content-type", "application/octet-stream")
      .set("x-etsy-signature", "badsignature")
      .set("x-etsy-request-timestamp", NOW_TS)
      .send(body);

    expect(res.status).toBe(401);
    expect(processOrder).not.toHaveBeenCalled();
  });

  it("missing signature header → 401", async () => {
    const processOrder = vi.fn();
    const app = createApp({ db: {} as never, processOrder });

    const body = makePayload(42);

    const res = await request(app)
      .post("/webhook/etsy-order")
      .set("content-type", "application/octet-stream")
      .set("x-etsy-request-timestamp", NOW_TS)
      .send(body);

    expect(res.status).toBe(401);
    expect(processOrder).not.toHaveBeenCalled();
  });

  it("replay timestamp (> 5 min old) → 401", async () => {
    const processOrder = vi.fn();
    const app = createApp({ db: {} as never, processOrder });

    const body = makePayload(42);
    const sig = signPayload(body, SECRET);
    const oldTs = String(Math.floor(Date.now() / 1000) - 400);

    const res = await request(app)
      .post("/webhook/etsy-order")
      .set("content-type", "application/octet-stream")
      .set("x-etsy-signature", sig)
      .set("x-etsy-request-timestamp", oldTs)
      .send(body);

    expect(res.status).toBe(401);
    expect(processOrder).not.toHaveBeenCalled();
  });

  it("same receipt twice: both 200; processOrder called twice", async () => {
    const processOrder = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "created", orderId: "order-1" })
      .mockResolvedValueOnce({ outcome: "duplicate" });
    const app = createApp({ db: {} as never, processOrder });

    const body = makePayload(42);
    const sig = signPayload(body, SECRET);

    for (let i = 0; i < 2; i++) {
      const res = await request(app)
        .post("/webhook/etsy-order")
        .set("content-type", "application/octet-stream")
        .set("x-etsy-signature", sig)
        .set("x-etsy-request-timestamp", NOW_TS)
        .send(body);
      expect(res.status).toBe(200);
    }

    expect(processOrder).toHaveBeenCalledTimes(2);
  });

  it("processOrder throws unexpectedly → still 200", async () => {
    const processOrder = vi.fn().mockRejectedValue(new Error("unexpected boom"));
    const app = createApp({ db: {} as never, processOrder });

    const body = makePayload(42);
    const sig = signPayload(body, SECRET);

    const res = await request(app)
      .post("/webhook/etsy-order")
      .set("content-type", "application/octet-stream")
      .set("x-etsy-signature", sig)
      .set("x-etsy-request-timestamp", NOW_TS)
      .send(body);

    expect(res.status).toBe(200);
  });
});

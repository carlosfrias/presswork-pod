import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createHmac } from "node:crypto";
import { createApp } from "./server.js";

// whsec_ prefix + base64("etsy-webhook-secret")
const SECRET = "whsec_ZXRzeS13ZWJob29rLXNlY3JldA==";
const MSG_ID = "msg_test_svix_001";

const validEnv = {
  ANTHROPIC_API_KEY: "sk-ant-test",
  ETSY_API_KEY: "etsy-key",
  ETSY_API_SECRET: "etsy-api-secret",
  ETSY_WEBHOOK_SECRET: SECRET,
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

function makePayload(receiptId: number) {
  return Buffer.from(JSON.stringify({ receipt_id: receiptId }));
}

function svixSign(secret: string, id: string, ts: string, body: Buffer): string {
  const decoded = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", decoded)
    .update(`${id}.${ts}.${body.toString("utf8")}`)
    .digest("base64");
  return `v1,${sig}`;
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

  it("valid Svix signature → 200, processOrder called with extracted receipt id", async () => {
    const processOrder = vi.fn().mockResolvedValue({ outcome: "created", orderId: "order-1" });
    const app = createApp({ db: {} as never, processOrder });

    const body = makePayload(42);
    const sig = svixSign(SECRET, MSG_ID, NOW_TS, body);

    const res = await request(app)
      .post("/webhook/etsy-order")
      .set("content-type", "application/octet-stream")
      .set("webhook-id", MSG_ID)
      .set("webhook-timestamp", NOW_TS)
      .set("webhook-signature", sig)
      .send(body);

    expect(res.status).toBe(200);
    expect(processOrder).toHaveBeenCalledOnce();
    expect(processOrder).toHaveBeenCalledWith(expect.anything(), "42");
  });

  it("invalid Svix signature → 401, processOrder NOT called", async () => {
    const processOrder = vi.fn();
    const app = createApp({ db: {} as never, processOrder });

    const body = makePayload(42);

    const res = await request(app)
      .post("/webhook/etsy-order")
      .set("content-type", "application/octet-stream")
      .set("webhook-id", MSG_ID)
      .set("webhook-timestamp", NOW_TS)
      .set("webhook-signature", "v1,badsignature")
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
      .set("webhook-id", MSG_ID)
      .set("webhook-timestamp", NOW_TS)
      .send(body);

    expect(res.status).toBe(401);
    expect(processOrder).not.toHaveBeenCalled();
  });

  it("replay timestamp (> 5 min old) → 401", async () => {
    const processOrder = vi.fn();
    const app = createApp({ db: {} as never, processOrder });

    const body = makePayload(42);
    const oldTs = String(Math.floor(Date.now() / 1000) - 400);
    const sig = svixSign(SECRET, MSG_ID, oldTs, body);

    const res = await request(app)
      .post("/webhook/etsy-order")
      .set("content-type", "application/octet-stream")
      .set("webhook-id", MSG_ID)
      .set("webhook-timestamp", oldTs)
      .set("webhook-signature", sig)
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
    const sig = svixSign(SECRET, MSG_ID, NOW_TS, body);

    for (let i = 0; i < 2; i++) {
      const res = await request(app)
        .post("/webhook/etsy-order")
        .set("content-type", "application/octet-stream")
        .set("webhook-id", MSG_ID)
        .set("webhook-timestamp", NOW_TS)
        .set("webhook-signature", sig)
        .send(body);
      expect(res.status).toBe(200);
    }

    expect(processOrder).toHaveBeenCalledTimes(2);
  });

  it("oversized webhook body → 413, processOrder NOT called (limit: 1mb)", async () => {
    const processOrder = vi.fn();
    const app = createApp({ db: {} as never, processOrder });

    // Send a payload larger than the configured 1mb limit. express.raw rejects
    // it with 413 before any HMAC verification runs.
    const oversized = Buffer.alloc(2 * 1024 * 1024, 0x61); // 2MB of 'a'

    const res = await request(app)
      .post("/webhook/etsy-order")
      .set("content-type", "application/octet-stream")
      .send(oversized);

    expect(res.status).toBe(413);
    expect(processOrder).not.toHaveBeenCalled();
  });

  it("processOrder throws unexpectedly → still 200", async () => {
    const processOrder = vi.fn().mockRejectedValue(new Error("unexpected boom"));
    const app = createApp({ db: {} as never, processOrder });

    const body = makePayload(42);
    const sig = svixSign(SECRET, MSG_ID, NOW_TS, body);

    const res = await request(app)
      .post("/webhook/etsy-order")
      .set("content-type", "application/octet-stream")
      .set("webhook-id", MSG_ID)
      .set("webhook-timestamp", NOW_TS)
      .set("webhook-signature", sig)
      .send(body);

    expect(res.status).toBe(200);
  });
});

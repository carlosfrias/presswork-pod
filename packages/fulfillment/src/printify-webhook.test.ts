import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import { verifyPrintifyWebhook } from "./printify-webhook.js";
import type { Request, Response } from "express";
import type { Db } from "@presswork/shared";

// ── Signature verification ────────────────────────────────────────────────────

const SECRET = "a-secret-value-that-is-at-least-32-bytes-long!";
const BODY = Buffer.from(JSON.stringify({ type: "order:updated" }));
const VALID_SIG = createHmac("sha256", SECRET).update(BODY).digest("base64");

describe("verifyPrintifyWebhook", () => {
  it("returns valid for a correct signature", () => {
    const result = verifyPrintifyWebhook(BODY, VALID_SIG, SECRET);
    expect(result.valid).toBe(true);
  });

  it("returns mismatch for a wrong signature", () => {
    const result = verifyPrintifyWebhook(BODY, "bad-sig", SECRET);
    expect(result).toEqual({ valid: false, reason: "mismatch" });
  });

  it("returns missing_signature when header is absent", () => {
    const result = verifyPrintifyWebhook(BODY, undefined, SECRET);
    expect(result).toEqual({ valid: false, reason: "missing_signature" });
  });

  it("returns missing_secret when secret is not configured", () => {
    const result = verifyPrintifyWebhook(BODY, VALID_SIG, undefined);
    expect(result).toEqual({ valid: false, reason: "missing_secret" });
  });
});

// ── handlePrintifyWebhook — idempotency no-op ─────────────────────────────────

function makeValidEnv(extra: Record<string, string> = {}) {
  return {
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
    PRINTIFY_WEBHOOK_SECRET: SECRET,
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    RESEND_API_KEY: "resend-key",
    ALERT_EMAIL: "alert@example.com",
    SLACK_WEBHOOK_URL: "https://hooks.slack.com/test",
    NODE_ENV: "test",
    LOG_LEVEL: "info",
    HUMAN_REVIEW_ENABLED: "true",
    ...extra,
  };
}

function makeReq(body: Buffer, sig: string): Request {
  return {
    body,
    headers: { "x-printify-hmac-sha256": sig },
  } as unknown as Request;
}

function makeRes() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
    _status: 0,
    _body: null as unknown,
  };
  res.status.mockReturnValue(res);
  res.json.mockImplementation((b: unknown) => { res._body = b; return res; });
  return res;
}

function makePayload(overrides: Record<string, unknown> = {}) {
  return Buffer.from(JSON.stringify({
    type: "order:updated",
    resource: {
      id: "res-1",
      type: "order",
      data: {
        id: "pf-order-1",
        status: "in_production",
      },
    },
    ...overrides,
  }));
}

describe("handlePrintifyWebhook", () => {
  it("returns 401 when signature is missing", async () => {
    const savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, makeValidEnv());

    const body = makePayload();
    const req = { body, headers: {} } as unknown as Request;
    const res = makeRes();
    const db = {} as Db;

    const { handlePrintifyWebhook: handler } = await import("./printify-webhook.js");
    await handler(req, res as unknown as Response, db);

    expect(res.status).toHaveBeenCalledWith(401);

    process.env = savedEnv;
  });

  it("returns 401 when signature is invalid", async () => {
    const savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, makeValidEnv());

    const body = makePayload();
    const req = makeReq(body, "not-the-right-sig");
    const res = makeRes();
    const db = {} as Db;

    const { handlePrintifyWebhook: handler } = await import("./printify-webhook.js");
    await handler(req, res as unknown as Response, db);

    expect(res.status).toHaveBeenCalledWith(401);

    process.env = savedEnv;
  });

  it("returns 200 skipped=status_unchanged when order:updated status matches current", async () => {
    const savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, makeValidEnv());

    // order:updated where DB already has status "in_production"
    const body = makePayload();
    const sig = createHmac("sha256", SECRET).update(body).digest("base64");
    const req = makeReq(body, sig);
    const res = makeRes();

    const db = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({
              data: [{ id: "order-uuid-1", etsy_order_id: "etsy-42", status: "in_production" }],
              error: null,
            }),
          }),
        }),
      }),
    } as unknown as Db;

    const { handlePrintifyWebhook: handler } = await import("./printify-webhook.js");
    await handler(req, res as unknown as Response, db);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res._body).toMatchObject({ ok: true, skipped: "status_unchanged" });

    process.env = savedEnv;
  });

  it("returns 200 skipped=already_shipped when order:shipment:created for already-shipped order", async () => {
    const savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, makeValidEnv());

    const body = Buffer.from(JSON.stringify({
      type: "order:shipment:created",
      resource: {
        id: "res-1",
        type: "order",
        data: {
          id: "pf-order-1",
          status: "shipped",
          shipments: [{ carrier: "USPS", number: "1Z999", url: "https://track.usps.com/1Z999" }],
        },
      },
    }));
    const sig = createHmac("sha256", SECRET).update(body).digest("base64");
    const req = makeReq(body, sig);
    const res = makeRes();

    const db = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({
              data: [{ id: "order-uuid-1", etsy_order_id: "etsy-42", status: "shipped" }],
              error: null,
            }),
          }),
        }),
      }),
    } as unknown as Db;

    const { handlePrintifyWebhook: handler } = await import("./printify-webhook.js");
    await handler(req, res as unknown as Response, db);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res._body).toMatchObject({ ok: true, skipped: "already_shipped" });

    process.env = savedEnv;
  });
});

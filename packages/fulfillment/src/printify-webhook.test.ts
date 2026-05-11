import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
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
        status: "in-production",
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

  it("returns 200 skipped=status_unchanged when mapped status matches current", async () => {
    const savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, makeValidEnv());

    // Printify "in-production" maps to internal "submitted"; DB already has
    // status="submitted" → skip with status_unchanged.
    const body = makePayload();
    const sig = createHmac("sha256", SECRET).update(body).digest("base64");
    const req = makeReq(body, sig);
    const res = makeRes();

    const db = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({
              data: [{ id: "order-uuid-1", etsy_order_id: "etsy-42", status: "submitted" }],
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

  it("returns 200 skipped=already_shipped when conditional UPDATE returns no rows (concurrent delivery)", async () => {
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

    // UPDATE ... WHERE status != 'shipped' returns no rows because the row is
    // already 'shipped' (another delivery beat us here).
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
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            neq: vi.fn().mockReturnValue({
              select: vi.fn().mockResolvedValue({ data: [], error: null }),
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

  it("unknown Printify status → 200 skipped, DB untouched (bug #29)", async () => {
    const savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, makeValidEnv());

    const body = Buffer.from(JSON.stringify({
      type: "order:updated",
      resource: {
        id: "res-1",
        type: "order",
        data: { id: "pf-order-1", status: "totally-made-up-status" },
      },
    }));
    const sig = createHmac("sha256", SECRET).update(body).digest("base64");
    const req = makeReq(body, sig);
    const res = makeRes();

    const updateMock = vi.fn();
    const db = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({
              data: [{ id: "order-uuid-1", etsy_order_id: "etsy-42", status: "submitted" }],
              error: null,
            }),
          }),
        }),
        update: updateMock,
      }),
    } as unknown as Db;

    const { handlePrintifyWebhook: handler } = await import("./printify-webhook.js");
    await handler(req, res as unknown as Response, db);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res._body).toMatchObject({ skipped: "unknown_status" });
    expect(updateMock).not.toHaveBeenCalled();

    process.env = savedEnv;
  });

  it("maps fulfilled Printify status to internal 'shipped' (bug #29)", async () => {
    const savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, makeValidEnv());

    const body = Buffer.from(JSON.stringify({
      type: "order:updated",
      resource: {
        id: "res-1",
        type: "order",
        data: { id: "pf-order-1", status: "fulfilled" },
      },
    }));
    const sig = createHmac("sha256", SECRET).update(body).digest("base64");
    const req = makeReq(body, sig);
    const res = makeRes();

    const updateMock = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    });
    const db = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({
              data: [{ id: "order-uuid-1", etsy_order_id: "etsy-42", status: "submitted" }],
              error: null,
            }),
          }),
        }),
        update: updateMock,
      }),
    } as unknown as Db;

    const { handlePrintifyWebhook: handler } = await import("./printify-webhook.js");
    await handler(req, res as unknown as Response, db);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(updateMock).toHaveBeenCalledWith({ status: "shipped" });

    process.env = savedEnv;
  });

  it("submits Etsy tracking only when conditional UPDATE actually transitioned the row (bug #6)", async () => {
    const savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, makeValidEnv());

    const submitTracking = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@presswork/shared", async () => ({
      ...(await import("@presswork/shared")),
      submitTracking,
      notifySlack: vi.fn(),
    }));

    const body = Buffer.from(JSON.stringify({
      type: "order:shipment:created",
      resource: {
        id: "res-1",
        type: "order",
        data: {
          id: "pf-order-1",
          shipments: [{ carrier: "USPS", number: "1Z999", url: "https://track.usps.com/1Z999" }],
        },
      },
    }));
    const sig = createHmac("sha256", SECRET).update(body).digest("base64");
    const req = makeReq(body, sig);
    const res = makeRes();

    // Capture the filter chain on the UPDATE to verify .neq("status", "shipped")
    const eqMock = vi.fn();
    const neqMock = vi.fn();
    const db = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({
              data: [{ id: "order-uuid-1", etsy_order_id: "etsy-42", status: "submitted" }],
              error: null,
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          eq: eqMock.mockReturnValue({
            neq: neqMock.mockReturnValue({
              select: vi.fn().mockResolvedValue({
                data: [{ id: "order-uuid-1" }],
                error: null,
              }),
            }),
          }),
        }),
      }),
    } as unknown as Db;

    const { handlePrintifyWebhook: handler } = await import("./printify-webhook.js");
    await handler(req, res as unknown as Response, db);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(eqMock).toHaveBeenCalledWith("id", "order-uuid-1");
    expect(neqMock).toHaveBeenCalledWith("status", "shipped");
    expect(submitTracking).toHaveBeenCalledTimes(1);

    process.env = savedEnv;
  });
});

// ── registerPrintifyWebhooks (bug #36) ────────────────────────────────────────

const bootstrapServer = setupServer();

function makeBootstrapDb() {
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const deleteFn = vi.fn().mockReturnValue({
    eq: vi.fn().mockResolvedValue({ error: null }),
  });
  return {
    from: vi.fn().mockReturnValue({
      upsert,
      delete: deleteFn,
    }),
    _upsert: upsert,
    _delete: deleteFn,
  };
}

describe("registerPrintifyWebhooks (bug #36)", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(
      process.env,
      makeValidEnv({
        PRINTIFY_WEBHOOK_BASE_URL: "https://hooks.example.com",
      })
    );
    // @presswork/shared's getSettings caches at module load; resetModules
    // does NOT reliably clear workspace-package singletons. Mock it directly
    // so each test gets the env state we expect.
    vi.doMock("@presswork/shared", async () => {
      const actual = await vi.importActual<typeof import("@presswork/shared")>("@presswork/shared");
      return {
        ...actual,
        getSettings: () => ({
          PRINTIFY_SHOP_ID: process.env["PRINTIFY_SHOP_ID"] ?? "shop-1",
          PRINTIFY_WEBHOOK_BASE_URL: process.env["PRINTIFY_WEBHOOK_BASE_URL"],
          PRINTIFY_WEBHOOK_SECRET: process.env["PRINTIFY_WEBHOOK_SECRET"],
          PRINTIFY_API_TOKEN: process.env["PRINTIFY_API_TOKEN"] ?? "printify-token",
        }),
      };
    });
    bootstrapServer.listen({ onUnhandledRequest: "error" });
  });

  afterEach(() => {
    process.env = savedEnv;
    bootstrapServer.resetHandlers();
    bootstrapServer.close();
    vi.doUnmock("@presswork/shared");
  });

  it("POSTs both topics when subscription list is empty", async () => {
    // Sanity-check the env actually set
    expect(process.env["PRINTIFY_WEBHOOK_BASE_URL"]).toBe("https://hooks.example.com");
    expect(process.env["PRINTIFY_WEBHOOK_SECRET"]).toBeDefined();

    const created: Array<{ topic: string }> = [];
    bootstrapServer.use(
      http.get("https://api.printify.com/v1/shops/shop-1/webhooks.json", () =>
        HttpResponse.json([])
      ),
      http.post(
        "https://api.printify.com/v1/shops/shop-1/webhooks.json",
        async ({ request }) => {
          const body = (await request.json()) as { topic: string };
          created.push({ topic: body.topic });
          return HttpResponse.json({ id: `whk-${body.topic}` });
        }
      )
    );

    const { registerPrintifyWebhooks } = await import("./printify-webhook.js");
    await registerPrintifyWebhooks(makeBootstrapDb() as unknown as Db);

    expect(created.map((c) => c.topic).sort()).toEqual(
      ["order:shipment:created", "order:updated"].sort()
    );
  });

  it("does NOT POST when matching subscriptions already exist", async () => {
    let postCalls = 0;
    bootstrapServer.use(
      http.get("https://api.printify.com/v1/shops/shop-1/webhooks.json", () =>
        HttpResponse.json([
          { id: "w1", topic: "order:updated", url: "https://hooks.example.com/webhook/printify-order" },
          { id: "w2", topic: "order:shipment:created", url: "https://hooks.example.com/webhook/printify-order" },
        ])
      ),
      http.post("https://api.printify.com/v1/shops/shop-1/webhooks.json", () => {
        postCalls++;
        return HttpResponse.json({ id: "should-not-be-called" });
      })
    );

    const { registerPrintifyWebhooks } = await import("./printify-webhook.js");
    await registerPrintifyWebhooks(makeBootstrapDb() as unknown as Db);

    expect(postCalls).toBe(0);
  });

  it("DELETEs stale URL then POSTs new on PRINTIFY_WEBHOOK_BASE_URL change (bug #35)", async () => {
    const deletes: string[] = [];
    const posts: string[] = [];
    bootstrapServer.use(
      http.get("https://api.printify.com/v1/shops/shop-1/webhooks.json", () =>
        HttpResponse.json([
          { id: "stale-w1", topic: "order:updated", url: "https://old.example.com/webhook/printify-order" },
          { id: "stale-w2", topic: "order:shipment:created", url: "https://old.example.com/webhook/printify-order" },
        ])
      ),
      http.delete(
        "https://api.printify.com/v1/shops/shop-1/webhooks/:id.json",
        ({ params }) => {
          deletes.push(params.id as string);
          return HttpResponse.json({ ok: true });
        }
      ),
      http.post(
        "https://api.printify.com/v1/shops/shop-1/webhooks.json",
        async ({ request }) => {
          const body = (await request.json()) as { topic: string };
          posts.push(body.topic);
          return HttpResponse.json({ id: `whk-${body.topic}` });
        }
      )
    );

    const { registerPrintifyWebhooks } = await import("./printify-webhook.js");
    await registerPrintifyWebhooks(makeBootstrapDb() as unknown as Db);

    expect(deletes.sort()).toEqual(["stale-w1", "stale-w2"]);
    expect(posts.sort()).toEqual(["order:shipment:created", "order:updated"].sort());
  });

  it("skips bootstrap when PRINTIFY_WEBHOOK_BASE_URL is missing", async () => {
    process.env = { ...savedEnv, ...makeValidEnv() };
    delete process.env["PRINTIFY_WEBHOOK_BASE_URL"];
    let touched = 0;
    bootstrapServer.use(
      http.all("https://api.printify.com/v1/shops/shop-1/webhooks.json", () => {
        touched++;
        return HttpResponse.json([]);
      })
    );

    const { registerPrintifyWebhooks } = await import("./printify-webhook.js");
    await registerPrintifyWebhooks(makeBootstrapDb() as unknown as Db);

    expect(touched).toBe(0);
  });

  it("skips bootstrap when PRINTIFY_WEBHOOK_SECRET is missing", async () => {
    process.env = { ...savedEnv, ...makeValidEnv({ PRINTIFY_WEBHOOK_BASE_URL: "https://hooks.example.com" }) };
    delete process.env["PRINTIFY_WEBHOOK_SECRET"];
    let touched = 0;
    bootstrapServer.use(
      http.all("https://api.printify.com/v1/shops/shop-1/webhooks.json", () => {
        touched++;
        return HttpResponse.json([]);
      })
    );

    const { registerPrintifyWebhooks } = await import("./printify-webhook.js");
    await registerPrintifyWebhooks(makeBootstrapDb() as unknown as Db);

    expect(touched).toBe(0);
  });
});

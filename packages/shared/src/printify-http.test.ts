import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

const validEnv = {
  ANTHROPIC_API_KEY: "sk-ant-test",
  ETSY_API_KEY: "etsy-key",
  ETSY_API_SECRET: "etsy-secret",
  ETSY_SHOP_ID: "12345",
  ETSY_ACCESS_TOKEN: "access-token",
  ETSY_REFRESH_TOKEN: "refresh-token",
  ETSY_SHIPPING_PROFILE_ID: "99",
  ETSY_PRODUCTION_PARTNER_ID: "999001",
  ETSY_READINESS_STATE_ID: "1",
  FAL_KEY: "fal-key",
  PRINTIFY_API_TOKEN: "test-printify-token",
  PRINTIFY_SHOP_ID: "shop-test",
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

beforeEach(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => { server.resetHandlers(); server.close(); });

describe("printifyFetch — header compliance", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, validEnv);
  });

  afterEach(() => { process.env = savedEnv; });

  it("sends correct Content-Type with charset and User-Agent", async () => {
    let capturedContentType: string | null = null;
    let capturedUserAgent: string | null = null;

    server.use(
      http.post("https://api.printify.com/v1/test-headers", ({ request }) => {
        capturedContentType = request.headers.get("content-type");
        capturedUserAgent = request.headers.get("user-agent");
        return HttpResponse.json({ ok: true });
      })
    );

    const { printifyFetch } = await import("./printify-http.js");
    await printifyFetch("/test-headers", { method: "POST", body: JSON.stringify({}) });

    expect(capturedContentType).toBe("application/json;charset=utf-8");
    expect(capturedUserAgent).toMatch(/^presswork\//);
  });

  it("sets Authorization header from PRINTIFY_API_TOKEN", async () => {
    let capturedAuth: string | null = null;

    server.use(
      http.get("https://api.printify.com/v1/test-auth", ({ request }) => {
        capturedAuth = request.headers.get("authorization");
        return HttpResponse.json({ ok: true });
      })
    );

    const { printifyFetch } = await import("./printify-http.js");
    await printifyFetch("/test-auth");

    expect(capturedAuth).toBe("Bearer test-printify-token");
  });
});

describe("printifyFetch — 429 handling", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, validEnv);
  });

  afterEach(() => { process.env = savedEnv; });

  it("retries on 429 with Retry-After and succeeds on second attempt", async () => {
    let attempts = 0;

    server.use(
      http.post("https://api.printify.com/v1/test-429", () => {
        attempts++;
        if (attempts === 1) {
          return new HttpResponse("rate limited", {
            status: 429,
            headers: { "Retry-After": "2" },
          });
        }
        return HttpResponse.json({ success: true });
      })
    );

    const { printifyFetch, _printifyTestHooks } = await import("./printify-http.js");

    // Make sleep instant so the test does not actually wait 2 seconds
    const sleepSpy = vi.spyOn(_printifyTestHooks, "sleep").mockResolvedValue(undefined);

    const result = await printifyFetch("/test-429", { method: "POST" });

    expect(attempts).toBe(2);
    expect(result).toEqual({ success: true });
    // Verify it used the Retry-After value (2s = 2000ms) from the header
    expect(sleepSpy).toHaveBeenCalledWith(2000);

    sleepSpy.mockRestore();
  });

  it("uses DEFAULT_429_WAIT_MS when no Retry-After header is present", async () => {
    let attempts = 0;

    server.use(
      http.post("https://api.printify.com/v1/test-429-default", () => {
        attempts++;
        if (attempts === 1) {
          return new HttpResponse("rate limited", { status: 429 });
        }
        return HttpResponse.json({ success: true });
      })
    );

    const { printifyFetch, _printifyTestHooks, DEFAULT_429_WAIT_MS } = await import("./printify-http.js");

    const sleepSpy = vi.spyOn(_printifyTestHooks, "sleep").mockResolvedValue(undefined);

    await printifyFetch("/test-429-default", { method: "POST" });

    expect(attempts).toBe(2);
    expect(sleepSpy).toHaveBeenCalledWith(DEFAULT_429_WAIT_MS);

    sleepSpy.mockRestore();
  });

  it("exhausts 429 retries within the MAX_ATTEMPTS budget (bug #18)", async () => {
    let attempts = 0;

    server.use(
      http.post("https://api.printify.com/v1/test-429-exhaust", () => {
        attempts++;
        return new HttpResponse("rate limited", {
          status: 429,
          headers: { "Retry-After": "0" },
        });
      })
    );

    const { printifyFetch, _printifyTestHooks, PrintifyError, MAX_ATTEMPTS } = await import(
      "./printify-http.js"
    );

    const sleepSpy = vi.spyOn(_printifyTestHooks, "sleep").mockResolvedValue(undefined);

    await expect(printifyFetch("/test-429-exhaust", { method: "POST" })).rejects.toThrow(PrintifyError);
    // Unified budget: exactly MAX_ATTEMPTS outgoing requests, no nested fan-out.
    expect(attempts).toBe(MAX_ATTEMPTS);

    sleepSpy.mockRestore();
  });

  it("mixed 429 + 5xx cascade stays within MAX_ATTEMPTS (bug #18)", async () => {
    let attempts = 0;

    server.use(
      http.post("https://api.printify.com/v1/test-mixed", () => {
        attempts++;
        if (attempts === 1) return new HttpResponse("rate limited", { status: 429 });
        return new HttpResponse("server error", { status: 500 });
      })
    );

    const { printifyFetch, _printifyTestHooks, PrintifyError, MAX_ATTEMPTS } = await import(
      "./printify-http.js"
    );

    const sleepSpy = vi.spyOn(_printifyTestHooks, "sleep").mockResolvedValue(undefined);

    await expect(printifyFetch("/test-mixed", { method: "POST" })).rejects.toThrow(PrintifyError);
    // Total attempts across both error types must respect the unified budget.
    expect(attempts).toBe(MAX_ATTEMPTS);

    sleepSpy.mockRestore();
  });

  it("caps an oversized Retry-After at 60s (bug #18)", async () => {
    let attempts = 0;

    server.use(
      http.post("https://api.printify.com/v1/test-big-retry-after", () => {
        attempts++;
        if (attempts === 1) {
          // 1 hour — must be capped
          return new HttpResponse("rate limited", {
            status: 429,
            headers: { "Retry-After": "3600" },
          });
        }
        return HttpResponse.json({ ok: true });
      })
    );

    const { printifyFetch, _printifyTestHooks } = await import("./printify-http.js");
    const sleepSpy = vi.spyOn(_printifyTestHooks, "sleep").mockResolvedValue(undefined);

    await printifyFetch("/test-big-retry-after", { method: "POST" });

    expect(sleepSpy).toHaveBeenCalledWith(60_000);
    sleepSpy.mockRestore();
  });
});

describe("printifyFetch — error handling", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, validEnv);
  });

  afterEach(() => { process.env = savedEnv; });

  it("bails immediately on 4xx (non-429) without retrying", async () => {
    let attempts = 0;

    server.use(
      http.post("https://api.printify.com/v1/test-4xx", () => {
        attempts++;
        return new HttpResponse("bad request", { status: 400 });
      })
    );

    const { printifyFetch, PrintifyError } = await import("./printify-http.js");
    await expect(printifyFetch("/test-4xx", { method: "POST" })).rejects.toThrow(PrintifyError);
    expect(attempts).toBe(1);
  });

  it("retries on 5xx and eventually succeeds", async () => {
    let attempts = 0;

    server.use(
      http.post("https://api.printify.com/v1/test-5xx", () => {
        attempts++;
        if (attempts < 3) return new HttpResponse("server error", { status: 500 });
        return HttpResponse.json({ recovered: true });
      })
    );

    const { printifyFetch } = await import("./printify-http.js");
    const result = await printifyFetch("/test-5xx", { method: "POST" });

    expect(result).toEqual({ recovered: true });
    expect(attempts).toBe(3);
  });

  it("keeps Printify response body OUT of err.message but ON err.responseBody (audit #50)", async () => {
    // Printify 4xx responses can echo buyer address/email back. The message
    // gets persisted to orders.error_message and Slack — body must not leak.
    const sensitiveBody =
      '{"error":"address_invalid","echo":{"email":"buyer@example.com","first_line":"123 Buyer Lane"}}';

    server.use(
      http.post("https://api.printify.com/v1/test-pii", () =>
        new HttpResponse(sensitiveBody, { status: 422 })
      )
    );

    const { printifyFetch, PrintifyError } = await import("./printify-http.js");
    let caught: InstanceType<typeof PrintifyError> | null = null;
    try {
      await printifyFetch("/test-pii", { method: "POST" });
    } catch (err) {
      caught = err as InstanceType<typeof PrintifyError>;
    }

    expect(caught).toBeInstanceOf(PrintifyError);
    expect(caught!.message).toBe("Printify 422");
    expect(caught!.message).not.toContain("buyer@example.com");
    expect(caught!.message).not.toContain("123 Buyer Lane");
    // Body is preserved on the structured field for in-process debug logs.
    expect(caught!.responseBody).toBe(sensitiveBody);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const validEnv: Record<string, string> = {
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
  PRINTIFY_API_TOKEN: "printify-token",
  PRINTIFY_SHOP_ID: "shop-1",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  RESEND_API_KEY: "resend-key",
  ALERT_EMAIL: "alert@example.com",
  SLACK_WEBHOOK_URL: "https://hooks.slack.com/test",
  NODE_ENV: "test",
  LOG_LEVEL: "info",
};

interface CapturedLog {
  raw: string;
  parsed: Record<string, unknown>;
}

async function captureLog(
  agent: string,
  payload: Record<string, unknown>,
  message = "test"
): Promise<CapturedLog> {
  let raw = "";
  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      raw += String(chunk);
      return true;
    });
  try {
    const { getLogger } = await import("./logger.js");
    getLogger(agent).info(payload, message);
  } finally {
    stdoutSpy.mockRestore();
  }
  // pino writes one JSON object per call separated by newline.
  const line = raw.split("\n").find((l) => l.includes(`"agent":"${agent}"`));
  if (!line) throw new Error(`no pino line captured for agent=${agent}; got: ${raw}`);
  return { raw, parsed: JSON.parse(line) as Record<string, unknown> };
}

describe("logger redact config (audit #51)", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    Object.assign(process.env, validEnv);
    vi.resetModules();
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("redacts authorization headers (both casings, nested)", async () => {
    const { parsed, raw } = await captureLog("redact-auth", {
      authorization: "Bearer top-level-secret",
      Authorization: "Bearer top-level-secret-cap",
      headers: {
        authorization: "Bearer nested-secret",
        Authorization: "Bearer nested-secret-cap",
      },
    });
    expect(parsed["authorization"]).toBe("[REDACTED]");
    expect(parsed["Authorization"]).toBe("[REDACTED]");
    const headers = parsed["headers"] as Record<string, unknown>;
    expect(headers["authorization"]).toBe("[REDACTED]");
    expect(headers["Authorization"]).toBe("[REDACTED]");
    expect(raw).not.toContain("top-level-secret");
    expect(raw).not.toContain("nested-secret");
  });

  it("redacts token-shaped payload fields (access_token, refresh_token, api_key, token)", async () => {
    const { parsed, raw } = await captureLog("redact-tokens", {
      access_token: "at-value",
      refresh_token: "rt-value",
      api_key: "ak-value",
      apiKey: "ak-camel",
      token: "plain-token",
    });
    expect(parsed["access_token"]).toBe("[REDACTED]");
    expect(parsed["refresh_token"]).toBe("[REDACTED]");
    expect(parsed["api_key"]).toBe("[REDACTED]");
    expect(parsed["apiKey"]).toBe("[REDACTED]");
    expect(parsed["token"]).toBe("[REDACTED]");
    expect(raw).not.toMatch(/at-value|rt-value|ak-value|ak-camel|plain-token/);
  });

  it("redacts named env secret keys at top level", async () => {
    const sensitive: Record<string, string> = {
      SUPABASE_SERVICE_ROLE_KEY: "sb-secret",
      ANTHROPIC_API_KEY: "anthropic-secret",
      FAL_KEY: "fal-secret",
      PRINTIFY_API_TOKEN: "printify-secret",
      ETSY_API_KEY: "etsy-key-secret",
      ETSY_API_SECRET: "etsy-app-secret",
      ETSY_ACCESS_TOKEN: "etsy-access",
      ETSY_REFRESH_TOKEN: "etsy-refresh",
      PRINTIFY_WEBHOOK_SECRET: "p-wh-secret",
      ETSY_WEBHOOK_SECRET: "e-wh-secret",
      RESEND_API_KEY: "resend-secret",
      SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/SECRET",
    };
    const { parsed, raw } = await captureLog("redact-env", sensitive);
    for (const key of Object.keys(sensitive)) {
      expect(parsed[key], `expected ${key} redacted`).toBe("[REDACTED]");
    }
    for (const value of Object.values(sensitive)) {
      expect(raw).not.toContain(value);
    }
  });

  it("redacts nested env secret keys (one level deep)", async () => {
    const { parsed, raw } = await captureLog("redact-nested-env", {
      ctx: {
        FAL_KEY: "nested-fal",
        SUPABASE_SERVICE_ROLE_KEY: "nested-sb",
      },
    });
    const ctx = parsed["ctx"] as Record<string, unknown>;
    expect(ctx["FAL_KEY"]).toBe("[REDACTED]");
    expect(ctx["SUPABASE_SERVICE_ROLE_KEY"]).toBe("[REDACTED]");
    expect(raw).not.toMatch(/nested-fal|nested-sb/);
  });

  it("preserves non-sensitive fields verbatim", async () => {
    const { parsed } = await captureLog(
      "redact-preserve",
      {
        action: "publish",
        listing_id: "abc-123",
        duration_ms: 250,
      },
      "ok"
    );
    expect(parsed["action"]).toBe("publish");
    expect(parsed["listing_id"]).toBe("abc-123");
    expect(parsed["duration_ms"]).toBe(250);
    expect(parsed["msg"]).toBe("ok");
  });
});

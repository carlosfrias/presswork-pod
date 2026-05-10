import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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

describe("getSettings", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("parses a valid environment", async () => {
    Object.assign(process.env, validEnv);
    const { getSettings } = await import("../src/config.js");
    const settings = getSettings();
    expect(settings.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(settings.ETSY_SHIPPING_PROFILE_ID).toBe(99);
  });

  it("coerces ETSY_SHIPPING_PROFILE_ID string to number", async () => {
    Object.assign(process.env, { ...validEnv, ETSY_SHIPPING_PROFILE_ID: "42" });
    const { getSettings } = await import("../src/config.js");
    expect(getSettings().ETSY_SHIPPING_PROFILE_ID).toBe(42);
  });

  it('coerces HUMAN_REVIEW_ENABLED="false" to boolean false', async () => {
    Object.assign(process.env, { ...validEnv, HUMAN_REVIEW_ENABLED: "false" });
    const { getSettings } = await import("../src/config.js");
    expect(getSettings().HUMAN_REVIEW_ENABLED).toBe(false);
  });

  it("throws when a required var is missing", async () => {
    const env = { ...validEnv };
    delete (env as Record<string, string>)["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    Object.assign(process.env, env);
    const { getSettings } = await import("../src/config.js");
    expect(() => getSettings()).toThrow(/ANTHROPIC_API_KEY/);
  });
});

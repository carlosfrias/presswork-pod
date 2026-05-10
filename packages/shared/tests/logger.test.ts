import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const validEnv = {
  ANTHROPIC_API_KEY: "sk-ant-test",
  ETSY_API_KEY: "etsy-key",
  ETSY_API_SECRET: "etsy-secret",
  ETSY_SHOP_ID: "12345",
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

describe("getLogger", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("creates a logger with the agent name in the base context", async () => {
    Object.assign(process.env, validEnv);
    const { getLogger } = await import("../src/logger.js");
    const logger = getLogger("listing");
    // pino loggers expose the options they were created with via the options property
    expect((logger as unknown as { [bindings: string]: () => Record<string, unknown> }).bindings?.()).toMatchObject({ agent: "listing" });
  });

  it("returns the same logger instance for the same agent name", async () => {
    Object.assign(process.env, validEnv);
    const { getLogger } = await import("../src/logger.js");
    expect(getLogger("scout")).toBe(getLogger("scout"));
  });
});

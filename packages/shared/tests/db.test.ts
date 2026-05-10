import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({})),
}));

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
  RESEND_API_KEY: "resend-key",
  ALERT_EMAIL: "alert@example.com",
  SLACK_WEBHOOK_URL: "https://hooks.slack.com/test",
  NODE_ENV: "test",
  LOG_LEVEL: "info",
  HUMAN_REVIEW_ENABLED: "true",
};

// A real service_role JWT structure: header.payload.sig
// payload decodes to {"role":"service_role","iss":"test"}
function makeJwt(role: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ role, iss: "test" })).toString("base64url");
  return `${header}.${payload}.fakesig`;
}

describe("getDb", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("succeeds with a service_role key", async () => {
    Object.assign(process.env, { ...validEnv, SUPABASE_SERVICE_ROLE_KEY: makeJwt("service_role") });
    const { getDb } = await import("../src/db.js");
    expect(() => getDb()).not.toThrow();
  });

  it("throws when the anon key is passed", async () => {
    Object.assign(process.env, { ...validEnv, SUPABASE_SERVICE_ROLE_KEY: makeJwt("anon") });
    const { getDb } = await import("../src/db.js");
    expect(() => getDb()).toThrow(/service_role/);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Db } from "../src/db.js";

const validEnv = {
  ANTHROPIC_API_KEY: "sk-ant-test",
  ETSY_API_KEY: "etsy-key",
  ETSY_API_SECRET: "etsy-secret",
  ETSY_SHOP_ID: "12345",
  ETSY_ACCESS_TOKEN: "seed-access",
  ETSY_REFRESH_TOKEN: "seed-refresh",
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

function makeMockDb(configValue: unknown): Db {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: configValue, error: null }),
        }),
      }),
      upsert: vi.fn().mockResolvedValue({ error: null }),
    }),
  } as unknown as Db;
}

describe("getEtsyTokens", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, validEnv);
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("returns tokens from the config row when it exists", async () => {
    const { getEtsyTokens } = await import("../src/etsy-tokens.js");
    const db = makeMockDb({
      value: {
        accessToken: "stored-access",
        refreshToken: "stored-refresh",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    });
    const tokens = await getEtsyTokens(db);
    expect(tokens.accessToken).toBe("stored-access");
    expect(tokens.refreshToken).toBe("stored-refresh");
  });

  it("seeds from env vars when no config row exists", async () => {
    const { getEtsyTokens } = await import("../src/etsy-tokens.js");
    const db = makeMockDb(null);
    const tokens = await getEtsyTokens(db);
    expect(tokens.accessToken).toBe("seed-access");
    expect(tokens.refreshToken).toBe("seed-refresh");
    // expiresAt should be epoch (or close to it) so the caller knows to refresh immediately
    expect(new Date(tokens.expiresAt).getTime()).toBeLessThan(1000);
  });
});

describe("setEtsyTokens", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, validEnv);
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("upserts the config row with key='etsy_oauth'", async () => {
    const { setEtsyTokens } = await import("../src/etsy-tokens.js");
    const upsertMock = vi.fn().mockResolvedValue({ error: null });
    const db = { from: vi.fn().mockReturnValue({ upsert: upsertMock }) } as unknown as Db;

    await setEtsyTokens(db, {
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ key: "etsy_oauth" }),
      expect.anything()
    );
  });
});

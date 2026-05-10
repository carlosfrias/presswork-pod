import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

const TAXONOMY_URL = "https://openapi.etsy.com/v3/application/seller-taxonomy/nodes";

const validEnv = {
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
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  RESEND_API_KEY: "resend-key",
  ALERT_EMAIL: "alert@example.com",
  SLACK_WEBHOOK_URL: "https://hooks.slack.com/test",
  NODE_ENV: "test",
  LOG_LEVEL: "info",
  HUMAN_REVIEW_ENABLED: "true",
};

const TSHIRT_TREE = {
  results: [
    {
      id: 1,
      name: "Clothing",
      children: [
        {
          id: 2,
          name: "Tops & Tees",
          children: [
            { id: 68887043, name: "T-Shirts", children: [] },
          ],
        },
      ],
    },
  ],
};

const server = setupServer();
beforeEach(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  server.close();
});

function makeCachedDb(cachedId: number | null) {
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const maybeSingle = vi.fn().mockResolvedValue({
    data: cachedId !== null ? { value: String(cachedId) } : null,
  });
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ maybeSingle }),
      }),
      upsert,
    }),
    _upsert: upsert,
    _maybeSingle: maybeSingle,
  };
}

describe("getTaxonomyId", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, validEnv);
    vi.doMock("./etsy-auth.js", () => ({
      getValidAccessToken: vi.fn().mockResolvedValue("test-token"),
    }));
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("returns cached id without making an HTTP call", async () => {
    const db = makeCachedDb(68887043);
    const { getTaxonomyId } = await import("./etsy-taxonomy.js");
    const id = await getTaxonomyId(db as never, "tshirt");
    expect(id).toBe(68887043);
    // No HTTP handler registered — would throw if a fetch was made
    expect(db._upsert).not.toHaveBeenCalled();
  });

  it("fetches from Etsy and persists on cache miss", async () => {
    server.use(http.get(TAXONOMY_URL, () => HttpResponse.json(TSHIRT_TREE)));
    const db = makeCachedDb(null);
    const { getTaxonomyId } = await import("./etsy-taxonomy.js");
    const id = await getTaxonomyId(db as never, "tshirt");
    expect(id).toBe(68887043);
    expect(db._upsert).toHaveBeenCalledWith({
      key: "etsy_taxonomy_tshirt",
      value: "68887043",
    });
  });

  it("finds a deeply nested leaf by name", async () => {
    server.use(http.get(TAXONOMY_URL, () => HttpResponse.json(TSHIRT_TREE)));
    const db = makeCachedDb(null);
    const { getTaxonomyId } = await import("./etsy-taxonomy.js");
    const id = await getTaxonomyId(db as never, "tshirt");
    expect(id).toBe(68887043);
  });

  it("throws a clear error when the label is not in the tree", async () => {
    server.use(
      http.get(TAXONOMY_URL, () =>
        HttpResponse.json({ results: [{ id: 1, name: "Electronics", children: [] }] })
      )
    );
    const db = makeCachedDb(null);
    const { getTaxonomyId } = await import("./etsy-taxonomy.js");
    await expect(getTaxonomyId(db as never, "tshirt")).rejects.toThrow(/not found.*tshirt/i);
  });
});

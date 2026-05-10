import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Db, DesignPackage, TrendBrief } from "@presswork/shared";

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
  PRINTIFY_SHOP_ID: "shop-99",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  RESEND_API_KEY: "resend-key",
  ALERT_EMAIL: "alert@example.com",
  SLACK_WEBHOOK_URL: "https://hooks.slack.com/test",
  NODE_ENV: "test",
  LOG_LEVEL: "info",
  HUMAN_REVIEW_ENABLED: "false",
};

const LISTING_ID = "00000000-0000-0000-0000-000000000099";
const PRODUCT_ID = "printify-product-abc";

const design: DesignPackage = {
  id: "00000000-0000-0000-0000-000000000001",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  status: "done",
  image_url: "https://cdn.supabase.co/designs/test.png",
  printify_blueprint_id: 5,
  printify_variant_ids: [1, 2, 3],
  retry_count: 0,
};

const brief: TrendBrief = {
  id: "00000000-0000-0000-0000-000000000002",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  status: "done",
  niche: "cat lovers",
  price_target_usd: 24.99,
  retry_count: 0,
};

function makeDb(updates: Array<{ table: string; data: Record<string, unknown> }>) {
  const builder = {
    insert: vi.fn().mockReturnThis() as ReturnType<typeof vi.fn>,
    update: vi.fn().mockReturnThis() as ReturnType<typeof vi.fn>,
    select: vi.fn().mockReturnThis() as ReturnType<typeof vi.fn>,
    eq: vi.fn().mockReturnThis() as ReturnType<typeof vi.fn>,
    single: vi.fn().mockResolvedValue({ data: { id: LISTING_ID }, error: null }),
  };

  // Intercept update calls to capture data
  builder.update.mockImplementation((data: Record<string, unknown>) => {
    const table = (builder as { _currentTable?: string })._currentTable ?? "";
    updates.push({ table, data });
    return builder;
  });

  return {
    from: vi.fn((table: string) => {
      (builder as { _currentTable?: string })._currentTable = table;
      return builder;
    }),
  } as unknown as Db;
}

describe("publishOne", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, validEnv);
  });

  afterEach(() => {
    process.env = savedEnv;
    vi.restoreAllMocks();
  });

  it("persists printify_product_id on the listings row after Printify product creation", async () => {
    vi.doMock("./copywriter.js", () => ({
      writeCopy: vi.fn().mockResolvedValue({
        title: "Cat Tee",
        description: "A great design. This design was created using AI image generation tools.",
        tags: Array(13).fill("tag"),
      }),
    }));

    vi.doMock("./printify.js", () => ({
      createHiddenProduct: vi.fn().mockResolvedValue({
        productId: PRODUCT_ID,
        mockupUrls: ["https://example.com/mockup.jpg"],
      }),
      setProductVisible: vi.fn().mockResolvedValue(undefined),
    }));

    vi.doMock("@presswork/shared", async () => {
      const actual = await vi.importActual<typeof import("@presswork/shared")>("@presswork/shared");
      return {
        ...actual,
        createDraftListing: vi.fn().mockResolvedValue({ listing_id: 777, state: "draft", title: "Cat Tee" }),
        uploadListingImage: vi.fn().mockResolvedValue(undefined),
        activateListing: vi.fn().mockResolvedValue(undefined),
        getSettings: vi.fn().mockReturnValue({
          HUMAN_REVIEW_ENABLED: false,
          ETSY_SHIPPING_PROFILE_ID: 99,
        }),
        getLogger: vi.fn().mockReturnValue({ info: vi.fn(), error: vi.fn() }),
      };
    });

    const updates: Array<{ table: string; data: Record<string, unknown> }> = [];
    const db = makeDb(updates);

    const { publishOne } = await import("./publisher.js");
    await publishOne(db, design, brief);

    const listingUpdatesWithProductId = updates.filter(
      (u) => u.table === "listings" && "printify_product_id" in u.data
    );
    expect(listingUpdatesWithProductId).toHaveLength(1);
    expect(listingUpdatesWithProductId[0]?.data.printify_product_id).toBe(PRODUCT_ID);
  });
});

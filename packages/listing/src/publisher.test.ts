import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AI_DISCLOSURE_TEXT, type Db, type DesignPackage, type TrendBrief } from "@presswork/shared";

const PARTNER_ID = 88123;

const validEnv = {
  ANTHROPIC_API_KEY: "sk-ant-test",
  ETSY_API_KEY: "etsy-key",
  ETSY_API_SECRET: "etsy-secret",
  ETSY_SHOP_ID: "12345",
  ETSY_ACCESS_TOKEN: "access-token",
  ETSY_REFRESH_TOKEN: "refresh-token",
  ETSY_SHIPPING_PROFILE_ID: "99",
  ETSY_PRODUCTION_PARTNER_ID: String(PARTNER_ID),
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

const COMPLIANT_DESCRIPTION = `A great cat tee for cat lovers everywhere. Soft, comfy, and ready to ship. ${AI_DISCLOSURE_TEXT}`;
const COMPLIANT_TAGS = Array(13).fill("cat tee");
const COMPLIANT_TITLE = "Funny Cat T-Shirt for Cat Lovers Soft Cotton Tee";

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

  function mockPrintify(productId = PRODUCT_ID) {
    vi.doMock("./printify.js", () => ({
      createHiddenProduct: vi.fn().mockResolvedValue({
        productId,
        mockupUrls: ["https://example.com/mockup.jpg"],
      }),
      setProductVisible: vi.fn().mockResolvedValue(undefined),
    }));
  }

  function mockSharedAndEtsy(overrides?: { partnerId?: number | null }) {
    const createDraftListing = vi
      .fn()
      .mockResolvedValue({ listing_id: 777, state: "draft", title: COMPLIANT_TITLE });

    vi.doMock("@presswork/shared", async () => {
      const actual = await vi.importActual<typeof import("@presswork/shared")>("@presswork/shared");
      return {
        ...actual,
        createDraftListing,
        uploadListingImage: vi.fn().mockResolvedValue(undefined),
        activateListing: vi.fn().mockResolvedValue(undefined),
        getSettings: vi.fn().mockReturnValue({
          HUMAN_REVIEW_ENABLED: false,
          ETSY_SHIPPING_PROFILE_ID: 99,
          ETSY_PRODUCTION_PARTNER_ID:
            overrides && "partnerId" in overrides ? overrides.partnerId : PARTNER_ID,
        }),
        getLogger: vi.fn().mockReturnValue({ info: vi.fn(), error: vi.fn() }),
      };
    });

    return { createDraftListing };
  }

  it("persists printify_product_id and sets mockups_from_actual_design=true after Printify product creation", async () => {
    vi.doMock("./copywriter.js", () => ({
      writeCopy: vi.fn().mockResolvedValue({
        title: COMPLIANT_TITLE,
        description: COMPLIANT_DESCRIPTION,
        tags: COMPLIANT_TAGS,
      }),
    }));
    mockPrintify();
    mockSharedAndEtsy();

    const updates: Array<{ table: string; data: Record<string, unknown> }> = [];
    const db = makeDb(updates);

    const { publishOne } = await import("./publisher.js");
    await publishOne(db, design, brief);

    const listingUpdatesWithProductId = updates.filter(
      (u) => u.table === "listings" && "printify_product_id" in u.data
    );
    expect(listingUpdatesWithProductId).toHaveLength(1);
    expect(listingUpdatesWithProductId[0]?.data.printify_product_id).toBe(PRODUCT_ID);

    // Compliance rule 4: provenance flag must be flipped true on the design_packages row
    const dpUpdates = updates.filter(
      (u) => u.table === "design_packages" && "mockups_from_actual_design" in u.data
    );
    expect(dpUpdates).toHaveLength(1);
    expect(dpUpdates[0]?.data["mockups_from_actual_design"]).toBe(true);
  });

  it("forwards production_partner_ids to createDraftListing (compliance rule 1)", async () => {
    vi.doMock("./copywriter.js", () => ({
      writeCopy: vi.fn().mockResolvedValue({
        title: COMPLIANT_TITLE,
        description: COMPLIANT_DESCRIPTION,
        tags: COMPLIANT_TAGS,
      }),
    }));
    mockPrintify();
    const { createDraftListing } = mockSharedAndEtsy();

    const db = makeDb([]);
    const { publishOne } = await import("./publisher.js");
    await publishOne(db, design, brief);

    expect(createDraftListing).toHaveBeenCalledTimes(1);
    const arg = createDraftListing.mock.calls[0]?.[1] as { production_partner_ids?: number[] };
    expect(arg.production_partner_ids).toEqual([PARTNER_ID]);
  });

  it("rejects publish when copy contains a forbidden term (compliance rule 3)", async () => {
    vi.doMock("./copywriter.js", () => ({
      writeCopy: vi.fn().mockResolvedValue({
        title: "Handmade Cat Tee Unique Gift",
        description: COMPLIANT_DESCRIPTION,
        tags: COMPLIANT_TAGS,
      }),
    }));
    mockPrintify();
    mockSharedAndEtsy();

    const db = makeDb([]);
    const { publishOne } = await import("./publisher.js");
    const { ComplianceError } = await import("./compliance.js");

    await expect(publishOne(db, design, brief)).rejects.toThrow(ComplianceError);
  });

  it("rejects publish when description is missing the AI disclosure (compliance rule 2)", async () => {
    vi.doMock("./copywriter.js", () => ({
      writeCopy: vi.fn().mockResolvedValue({
        title: COMPLIANT_TITLE,
        description: "A great cat tee. No disclosure here at all.",
        tags: COMPLIANT_TAGS,
      }),
    }));
    mockPrintify();
    mockSharedAndEtsy();

    const db = makeDb([]);
    const { publishOne } = await import("./publisher.js");
    const { ComplianceError } = await import("./compliance.js");

    await expect(publishOne(db, design, brief)).rejects.toThrow(ComplianceError);
  });

  it("rejects publish when copy contains an external URL (compliance rule 6)", async () => {
    vi.doMock("./copywriter.js", () => ({
      writeCopy: vi.fn().mockResolvedValue({
        title: COMPLIANT_TITLE,
        description: `${COMPLIANT_DESCRIPTION} Visit https://mystore.example.com for more.`,
        tags: COMPLIANT_TAGS,
      }),
    }));
    mockPrintify();
    mockSharedAndEtsy();

    const db = makeDb([]);
    const { publishOne } = await import("./publisher.js");
    const { ComplianceError } = await import("./compliance.js");

    await expect(publishOne(db, design, brief)).rejects.toThrow(ComplianceError);
  });

  it("rejects publish when ETSY_PRODUCTION_PARTNER_ID is missing (compliance rule 1)", async () => {
    vi.doMock("./copywriter.js", () => ({
      writeCopy: vi.fn().mockResolvedValue({
        title: COMPLIANT_TITLE,
        description: COMPLIANT_DESCRIPTION,
        tags: COMPLIANT_TAGS,
      }),
    }));
    mockPrintify();
    mockSharedAndEtsy({ partnerId: null });

    const db = makeDb([]);
    const { publishOne } = await import("./publisher.js");
    const { ComplianceError } = await import("./compliance.js");

    await expect(publishOne(db, design, brief)).rejects.toThrow(ComplianceError);
  });
});

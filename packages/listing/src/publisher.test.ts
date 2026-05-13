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
  ETSY_READINESS_STATE_ID: "42",
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
  printify_blueprint_id: 145,
  printify_print_provider_id: 3,
  printify_variant_ids: [38163, 38177, 38191],
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

type DbMockOpts = {
  existingListing?: Partial<{
    id: string;
    status: string;
    title: string | null;
    description: string | null;
    tags: string[] | null;
    price_usd: number | null;
    printify_product_id: string | null;
    is_active: boolean | null;
    retry_count: number | null;
  }> | null;
  retryCount?: number;
  existingEtsyListingId?: number | null;
  retryCountReadError?: string;
};

type CaptureEntry = { table: string; data: Record<string, unknown> };

function makeDb(updates: CaptureEntry[], opts: DbMockOpts = {}) {
  let currentTable = "";
  let currentSelectCols = "";

  const builder = {
    insert: vi.fn(),
    update: vi.fn(),
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    single: vi.fn(),
    maybeSingle: vi.fn(),
  };

  builder.insert.mockImplementation(() => builder);
  builder.update.mockImplementation((data: Record<string, unknown>) => {
    updates.push({ table: currentTable, data });
    return builder;
  });
  builder.select.mockImplementation((cols?: string) => {
    currentSelectCols = cols ?? "";
    return builder;
  });
  builder.eq.mockImplementation(() => builder);
  builder.order.mockImplementation(() => builder);
  builder.limit.mockImplementation(() => builder);

  builder.maybeSingle.mockImplementation(async () => {
    // Checkpoint lookup of an existing listings row by design_package_id.
    return { data: opts.existingListing ?? null, error: null };
  });

  builder.single.mockImplementation(async () => {
    if (currentSelectCols === "id") {
      return { data: { id: LISTING_ID }, error: null };
    }
    if (currentSelectCols === "retry_count") {
      if (opts.retryCountReadError) {
        return { data: null, error: { message: opts.retryCountReadError } };
      }
      return { data: { retry_count: opts.retryCount ?? 0 }, error: null };
    }
    if (currentSelectCols === "etsy_listing_id") {
      return { data: { etsy_listing_id: opts.existingEtsyListingId ?? null }, error: null };
    }
    if (currentSelectCols.includes("design_packages")) {
      return {
        data: { design_packages: { mockup_urls: [], mockups_from_actual_design: true } },
        error: null,
      };
    }
    // resumePublish reads a multi-column row; fall through to existingListing.
    if (currentSelectCols.startsWith("status,") && opts.existingListing) {
      return { data: opts.existingListing, error: null };
    }
    return { data: { id: LISTING_ID }, error: null };
  });

  return {
    from: vi.fn((table: string) => {
      currentTable = table;
      currentSelectCols = "";
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
    const createHiddenProduct = vi.fn().mockResolvedValue({
      productId,
      mockupUrls: ["https://example.com/mockup.jpg"],
    });
    const setProductVisible = vi.fn().mockResolvedValue(undefined);
    vi.doMock("./printify.js", () => ({
      createHiddenProduct,
      setProductVisible,
    }));
    return { createHiddenProduct, setProductVisible };
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
        getTaxonomyId: vi.fn().mockResolvedValue(68887043),
        getSettings: vi.fn().mockReturnValue({
          ETSY_SHIPPING_PROFILE_ID: 99,
          ETSY_READINESS_STATE_ID: 42,
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

    const updates: CaptureEntry[] = [];
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

  it("publishOne pauses at needs_review without calling Etsy (every agent waits for review)", async () => {
    vi.doMock("./copywriter.js", () => ({
      writeCopy: vi.fn().mockResolvedValue({
        title: COMPLIANT_TITLE,
        description: COMPLIANT_DESCRIPTION,
        tags: COMPLIANT_TAGS,
      }),
    }));
    mockPrintify();
    const { createDraftListing } = mockSharedAndEtsy();

    const updates: CaptureEntry[] = [];
    const db = makeDb(updates);
    const { publishOne } = await import("./publisher.js");
    await publishOne(db, design, brief);

    // Etsy is NEVER contacted from publishOne. The Etsy publish happens later
    // in resumePublish, after the dashboard flips status to pending_publish.
    expect(createDraftListing).not.toHaveBeenCalled();

    const listingStatusWrites = updates
      .filter((u) => u.table === "listings" && "status" in u.data)
      .map((u) => u.data.status);
    expect(listingStatusWrites).toContain("needs_review");
    expect(listingStatusWrites).not.toContain("pending_publish");
    expect(listingStatusWrites).not.toContain("publishing");
    expect(listingStatusWrites).not.toContain("active");
  });

  it("resumePublish forwards readiness_state_id, taxonomy_id, and production_partner_ids to createDraftListing", async () => {
    vi.doMock("./copywriter.js", () => ({
      writeCopy: vi.fn().mockResolvedValue({
        title: COMPLIANT_TITLE,
        description: COMPLIANT_DESCRIPTION,
        tags: COMPLIANT_TAGS,
      }),
    }));
    mockPrintify();
    const { createDraftListing } = mockSharedAndEtsy();

    const db = makeDb([], {
      existingListing: {
        id: LISTING_ID,
        status: "pending_publish",
        title: COMPLIANT_TITLE,
        description: COMPLIANT_DESCRIPTION,
        tags: COMPLIANT_TAGS,
        price_usd: 24.99,
        printify_product_id: PRODUCT_ID,
        is_active: false,
        retry_count: 0,
      },
    });
    const { resumePublish } = await import("./publisher.js");
    await resumePublish(db, LISTING_ID);

    expect(createDraftListing).toHaveBeenCalledTimes(1);
    const arg = createDraftListing.mock.calls[0]?.[1] as {
      readiness_state_id?: number;
      taxonomy_id?: number;
      production_partner_ids?: number[];
    };
    expect(arg.readiness_state_id).toBe(42);
    expect(arg.taxonomy_id).toBe(68887043); // from getTaxonomyId mock
    expect(arg.production_partner_ids).toEqual([PARTNER_ID]); // compliance rule 1
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

  it("forwards printify_print_provider_id from the design row to createHiddenProduct", async () => {
    vi.doMock("./copywriter.js", () => ({
      writeCopy: vi.fn().mockResolvedValue({
        title: COMPLIANT_TITLE,
        description: COMPLIANT_DESCRIPTION,
        tags: COMPLIANT_TAGS,
      }),
    }));
    const { createHiddenProduct } = mockPrintify();
    mockSharedAndEtsy();

    const db = makeDb([]);
    const { publishOne } = await import("./publisher.js");
    await publishOne(db, design, brief);

    expect(createHiddenProduct).toHaveBeenCalledTimes(1);
    const arg = createHiddenProduct.mock.calls[0]?.[0] as {
      blueprintId: number;
      printProviderId: number;
      variantIds: number[];
    };
    expect(arg.blueprintId).toBe(145);
    expect(arg.printProviderId).toBe(3);
    expect(arg.variantIds).toEqual([38163, 38177, 38191]);
  });

  it("rejects publish when design row is missing printify_print_provider_id", async () => {
    vi.doMock("./copywriter.js", () => ({
      writeCopy: vi.fn().mockResolvedValue({
        title: COMPLIANT_TITLE,
        description: COMPLIANT_DESCRIPTION,
        tags: COMPLIANT_TAGS,
      }),
    }));
    mockPrintify();
    mockSharedAndEtsy();

    const designWithoutProvider: DesignPackage = {
      ...design,
      printify_print_provider_id: null,
    };
    const db = makeDb([]);
    const { publishOne, PublisherError } = await import("./publisher.js");
    await expect(publishOne(db, designWithoutProvider, brief)).rejects.toThrow(PublisherError);
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

  it("resumePublish writes status='publishing' before Etsy publish (bug #4 checkpoint)", async () => {
    vi.doMock("./copywriter.js", () => ({
      writeCopy: vi.fn().mockResolvedValue({
        title: COMPLIANT_TITLE,
        description: COMPLIANT_DESCRIPTION,
        tags: COMPLIANT_TAGS,
      }),
    }));
    mockPrintify();
    mockSharedAndEtsy();

    const updates: CaptureEntry[] = [];
    const db = makeDb(updates, {
      existingListing: {
        id: LISTING_ID,
        status: "pending_publish",
        title: COMPLIANT_TITLE,
        description: COMPLIANT_DESCRIPTION,
        tags: COMPLIANT_TAGS,
        price_usd: 24.99,
        printify_product_id: PRODUCT_ID,
        is_active: false,
        retry_count: 0,
      },
    });
    const { resumePublish } = await import("./publisher.js");
    await resumePublish(db, LISTING_ID);

    const listingStatusWrites = updates
      .filter((u) => u.table === "listings" && "status" in u.data)
      .map((u) => u.data.status);
    expect(listingStatusWrites).toContain("publishing");
    expect(listingStatusWrites).toContain("active");
    // 'publishing' must precede 'active' in the write order.
    const publishingIdx = listingStatusWrites.indexOf("publishing");
    const activeIdx = listingStatusWrites.indexOf("active");
    expect(publishingIdx).toBeLessThan(activeIdx);
  });

  // Retry/error-budget tests still target publishOne, but the failure source
  // is Printify (the pre-pause path is the only thing that can still throw
  // from publishOne — Etsy publish moved to resumePublish).
  function mockPrintifyFailure() {
    const createHiddenProduct = vi.fn().mockRejectedValueOnce(new Error("printify 500"));
    const setProductVisible = vi.fn().mockResolvedValue(undefined);
    vi.doMock("./printify.js", () => ({ createHiddenProduct, setProductVisible }));
    return { createHiddenProduct };
  }

  it("resets design_packages to 'done' on retryable failure (bug #1)", async () => {
    vi.doMock("./copywriter.js", () => ({
      writeCopy: vi.fn().mockResolvedValue({
        title: COMPLIANT_TITLE,
        description: COMPLIANT_DESCRIPTION,
        tags: COMPLIANT_TAGS,
      }),
    }));
    mockPrintifyFailure();
    mockSharedAndEtsy();

    const updates: CaptureEntry[] = [];
    const db = makeDb(updates, { retryCount: 0 });

    const { publishOne } = await import("./publisher.js");
    await expect(publishOne(db, design, brief)).rejects.toThrow();

    const dpStatusWrites = updates
      .filter((u) => u.table === "design_packages" && "status" in u.data)
      .map((u) => u.data.status);
    expect(dpStatusWrites).toContain("done");
    expect(dpStatusWrites).not.toContain("processing");
  });

  it("sets design_packages to 'error' on terminal failure (retry >= 3)", async () => {
    vi.doMock("./copywriter.js", () => ({
      writeCopy: vi.fn().mockResolvedValue({
        title: COMPLIANT_TITLE,
        description: COMPLIANT_DESCRIPTION,
        tags: COMPLIANT_TAGS,
      }),
    }));
    mockPrintifyFailure();
    mockSharedAndEtsy();

    const updates: CaptureEntry[] = [];
    const db = makeDb(updates, { retryCount: 2 }); // current retry_count=2; +1 = 3 → terminal

    const { publishOne } = await import("./publisher.js");
    await expect(publishOne(db, design, brief)).rejects.toThrow();

    const dpStatusWrites = updates
      .filter((u) => u.table === "design_packages" && "status" in u.data)
      .map((u) => u.data.status);
    expect(dpStatusWrites).toContain("error");

    const listingStatusWrites = updates
      .filter((u) => u.table === "listings" && "status" in u.data && "retry_count" in u.data)
      .map((u) => u.data.status);
    expect(listingStatusWrites).toContain("error");
  });

  it("treats retry_count read failure as terminal (audit #39)", async () => {
    vi.doMock("./copywriter.js", () => ({
      writeCopy: vi.fn().mockResolvedValue({
        title: COMPLIANT_TITLE,
        description: COMPLIANT_DESCRIPTION,
        tags: COMPLIANT_TAGS,
      }),
    }));
    mockPrintifyFailure();
    mockSharedAndEtsy();

    const updates: CaptureEntry[] = [];
    const db = makeDb(updates, { retryCountReadError: "db connection lost" });

    const { publishOne } = await import("./publisher.js");
    await expect(publishOne(db, design, brief)).rejects.toThrow();

    const listingTerminalWrite = updates.find(
      (u) => u.table === "listings" && u.data.status === "error" && "retry_count" in u.data
    );
    expect(listingTerminalWrite).toBeDefined();
    // retry_count is forced to MAX_RETRIES (3) when the read fails.
    expect(listingTerminalWrite!.data.retry_count).toBe(3);
    expect(String(listingTerminalWrite!.data.error_message)).toContain(
      "retry_count read failed"
    );

    const dpTerminalWrite = updates.find(
      (u) => u.table === "design_packages" && u.data.status === "error"
    );
    expect(dpTerminalWrite).toBeDefined();
  });

  it("resumes from an existing listings row and skips Printify product creation (bug #2)", async () => {
    const writeCopy = vi.fn().mockResolvedValue({
      title: COMPLIANT_TITLE,
      description: COMPLIANT_DESCRIPTION,
      tags: COMPLIANT_TAGS,
    });
    vi.doMock("./copywriter.js", () => ({ writeCopy }));
    const { createHiddenProduct } = mockPrintify();
    mockSharedAndEtsy();

    const updates: CaptureEntry[] = [];
    const db = makeDb(updates, {
      existingListing: {
        id: LISTING_ID,
        status: "pending",
        title: COMPLIANT_TITLE,
        description: COMPLIANT_DESCRIPTION,
        tags: COMPLIANT_TAGS,
        price_usd: 24.99,
        printify_product_id: "existing-product-xyz",
        is_active: false,
        retry_count: 1,
      },
    });

    const designWithMockups: DesignPackage = {
      ...design,
      mockup_urls: ["https://example.com/existing-mockup.jpg"],
    };

    const { publishOne } = await import("./publisher.js");
    await publishOne(db, designWithMockups, brief);

    expect(writeCopy).not.toHaveBeenCalled();
    expect(createHiddenProduct).not.toHaveBeenCalled();
  });

  it("resumePublish persists etsy_listing_id immediately after createDraftListing returns (bug #3)", async () => {
    vi.doMock("./copywriter.js", () => ({
      writeCopy: vi.fn().mockResolvedValue({
        title: COMPLIANT_TITLE,
        description: COMPLIANT_DESCRIPTION,
        tags: COMPLIANT_TAGS,
      }),
    }));
    mockPrintify();
    mockSharedAndEtsy();

    const updates: CaptureEntry[] = [];
    const db = makeDb(updates, {
      existingListing: {
        id: LISTING_ID,
        status: "pending_publish",
        title: COMPLIANT_TITLE,
        description: COMPLIANT_DESCRIPTION,
        tags: COMPLIANT_TAGS,
        price_usd: 24.99,
        printify_product_id: PRODUCT_ID,
        is_active: false,
        retry_count: 0,
      },
    });
    const { resumePublish } = await import("./publisher.js");
    await resumePublish(db, LISTING_ID);

    const etsyIdWrites = updates.filter(
      (u) => u.table === "listings" && "etsy_listing_id" in u.data
    );
    // Exactly one update writes etsy_listing_id — the one right after createDraftListing.
    expect(etsyIdWrites).toHaveLength(1);
    expect(etsyIdWrites[0]?.data.etsy_listing_id).toBe(777);

    // The 'active' transition no longer carries etsy_listing_id (it was persisted earlier).
    const activeWrite = updates.find(
      (u) => u.table === "listings" && u.data.status === "active"
    );
    expect(activeWrite).toBeDefined();
    expect("etsy_listing_id" in (activeWrite!.data)).toBe(false);
  });

  it("resumePublish skips createDraftListing when etsy_listing_id is already persisted (bug #3)", async () => {
    vi.doMock("./copywriter.js", () => ({
      writeCopy: vi.fn().mockResolvedValue({
        title: COMPLIANT_TITLE,
        description: COMPLIANT_DESCRIPTION,
        tags: COMPLIANT_TAGS,
      }),
    }));
    mockPrintify();
    const { createDraftListing } = mockSharedAndEtsy();

    const updates: CaptureEntry[] = [];
    const db = makeDb(updates, {
      existingListing: {
        id: LISTING_ID,
        status: "pending_publish",
        title: COMPLIANT_TITLE,
        description: COMPLIANT_DESCRIPTION,
        tags: COMPLIANT_TAGS,
        price_usd: 24.99,
        printify_product_id: "existing-product-xyz",
        is_active: false,
        retry_count: 1,
      },
      existingEtsyListingId: 5555,
    });

    const { resumePublish } = await import("./publisher.js");
    await resumePublish(db, LISTING_ID);

    expect(createDraftListing).not.toHaveBeenCalled();
  });

  it("second-pass validateProductionPartnerId throws if partner ID is cleared mid-flow (bug #37)", async () => {
    vi.doMock("./copywriter.js", () => ({
      writeCopy: vi.fn().mockResolvedValue({
        title: COMPLIANT_TITLE,
        description: COMPLIANT_DESCRIPTION,
        tags: COMPLIANT_TAGS,
      }),
    }));
    mockPrintify();

    // Resume via resumePublish drives executeEtsyPublish directly. We mock
    // getSettings to return a valid partner ID for the SELECT-then-publish
    // setup, then null it just before the inner validateProductionPartnerId
    // re-check fires. The second-pass validator must throw.
    let partnerId: number | null = PARTNER_ID;
    const createDraftListing = vi.fn().mockResolvedValue({
      listing_id: 777,
      state: "draft",
      title: COMPLIANT_TITLE,
    });

    vi.doMock("@presswork/shared", async () => {
      const actual = await vi.importActual<typeof import("@presswork/shared")>("@presswork/shared");
      return {
        ...actual,
        createDraftListing,
        uploadListingImage: vi.fn().mockResolvedValue(undefined),
        activateListing: vi.fn().mockResolvedValue(undefined),
        getTaxonomyId: vi.fn().mockResolvedValue(68887043),
        getSettings: vi.fn(() => ({
          ETSY_SHIPPING_PROFILE_ID: 99,
          ETSY_READINESS_STATE_ID: 42,
          ETSY_PRODUCTION_PARTNER_ID: partnerId,
        })),
        getLogger: vi.fn().mockReturnValue({ info: vi.fn(), error: vi.fn() }),
      };
    });

    const db = makeDb([], {
      existingListing: {
        id: LISTING_ID,
        status: "pending_publish",
        title: COMPLIANT_TITLE,
        description: COMPLIANT_DESCRIPTION,
        tags: COMPLIANT_TAGS,
        price_usd: 24.99,
        printify_product_id: "existing-product-xyz",
        is_active: false,
        retry_count: 0,
      },
    });

    const { resumePublish } = await import("./publisher.js");
    const { ComplianceError } = await import("./compliance.js");

    // Clear the partner ID so the second-pass check inside executeEtsyPublish
    // fires. This simulates a config drift between publishOne's outer check
    // and the inner one before Etsy is contacted.
    partnerId = null;

    await expect(resumePublish(db, LISTING_ID)).rejects.toThrow(ComplianceError);
    expect(createDraftListing).not.toHaveBeenCalled();
  });

  it("aborts when an active listing already exists for this design", async () => {
    vi.doMock("./copywriter.js", () => ({
      writeCopy: vi.fn().mockResolvedValue({
        title: COMPLIANT_TITLE,
        description: COMPLIANT_DESCRIPTION,
        tags: COMPLIANT_TAGS,
      }),
    }));
    mockPrintify();
    mockSharedAndEtsy();

    const db = makeDb([], {
      existingListing: {
        id: LISTING_ID,
        status: "active",
        title: COMPLIANT_TITLE,
        description: COMPLIANT_DESCRIPTION,
        tags: COMPLIANT_TAGS,
        price_usd: 24.99,
        printify_product_id: "existing-product-xyz",
        is_active: true,
        retry_count: 0,
      },
    });

    const { publishOne, PublisherError } = await import("./publisher.js");
    await expect(publishOne(db, design, brief)).rejects.toThrow(PublisherError);
  });
});

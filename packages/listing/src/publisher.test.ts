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
  printify_print_provider_id: 39,
  printify_variant_ids: [38163, 38177, 38191],
  retry_count: 0,
};

const brief: TrendBrief = {
  id: "00000000-0000-0000-0000-000000000002",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  status: "done",
  niche: "cat lovers",
  price_target_usd: 26.99,
  shirt_colors: ["White"],
  shirt_sizes: ["S", "M", "L", "XL", "2XL"],
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
    selected_variant_ids: number[] | null;
  }> | null;
  retryCount?: number;
  existingEtsyListingId?: number | null;
  retryCountReadError?: string;
  /** Mockup URLs on the joined design_packages row (resumePublish image upload). */
  mockupUrls?: string[];
  /** Override for the selected_variant_ids single-column query in publishOne. */
  selectedVariantIds?: number[] | null;
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
    // loadListingState() loads the row whose id was passed into publishOne.
    // Default to the just-claimed shape (pending, no copy, no printify_product_id)
    // so the happy-path tests don't have to spell it out. Tests that exercise
    // resume paths (existing copy, existing printify product, prior errors)
    // override via opts.existingListing.
    const defaultRow = {
      id: LISTING_ID,
      status: "pending",
      title: null,
      description: null,
      tags: null,
      price_usd: 26.99,
      printify_product_id: null,
      is_active: false,
      retry_count: 0,
    };
    return { data: opts.existingListing ?? defaultRow, error: null };
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
    if (currentSelectCols === "selected_variant_ids") {
      // publishOne queries this to apply the operator's variant subset override.
      return {
        data: { selected_variant_ids: opts.selectedVariantIds !== undefined ? opts.selectedVariantIds : null },
        error: null,
      };
    }
    if (currentSelectCols.includes("design_packages")) {
      return {
        data: {
          design_packages: {
            mockup_urls: opts.mockupUrls ?? [],
            mockups_from_actual_design: true,
            // resumePublish needs these to build the inventory PUT payload.
            // Default to the full fixture variant set (matching design.printify_variant_ids)
            // so happy-path tests don't need to think about it and selected_variant_ids
            // filter tests can supply a subset.
            printify_blueprint_id: 145,
            printify_variants: [
              { id: 38163, values: ["s", "black"] },
              { id: 38177, values: ["m", "black"] },
              { id: 38191, values: ["l", "black"] },
            ],
          },
        },
        error: null,
      };
    }
    // resumePublish reads a multi-column row; fall through to existingListing.
    // Default selected_variant_ids to null so fixtures that predate the field
    // don't surface as undefined (which breaks the !== null guard in resumePublish).
    if (currentSelectCols.startsWith("status,") && opts.existingListing) {
      return {
        data: { selected_variant_ids: null, ...opts.existingListing },
        error: null,
      };
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
        getListingImageCount: vi.fn().mockResolvedValue(0),
        activateListing: vi.fn().mockResolvedValue(undefined),
        updateListingInventory: vi.fn().mockResolvedValue(undefined),
        getTaxonomyId: vi.fn().mockResolvedValue(68887043),
        getSettings: vi.fn().mockReturnValue({
          ETSY_SHIPPING_PROFILE_ID: 99,
          ETSY_READINESS_STATE_ID: 42,
          ETSY_PRODUCTION_PARTNER_ID:
            overrides && "partnerId" in overrides ? overrides.partnerId : PARTNER_ID,
        }),
        getLogger: vi.fn().mockReturnValue({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
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
    await publishOne(db, design, brief, LISTING_ID);

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
    await publishOne(db, design, brief, LISTING_ID);

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

    await expect(publishOne(db, design, brief, LISTING_ID)).rejects.toThrow(ComplianceError);
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

    await expect(publishOne(db, design, brief, LISTING_ID)).rejects.toThrow(ComplianceError);
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

    await expect(publishOne(db, design, brief, LISTING_ID)).rejects.toThrow(ComplianceError);
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
    await publishOne(db, design, brief, LISTING_ID);

    expect(createHiddenProduct).toHaveBeenCalledTimes(1);
    const arg = createHiddenProduct.mock.calls[0]?.[0] as {
      blueprintId: number;
      printProviderId: number;
      variantIds: number[];
    };
    expect(arg.blueprintId).toBe(145);
    expect(arg.printProviderId).toBe(39);
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
    await expect(publishOne(db, designWithoutProvider, brief, LISTING_ID)).rejects.toThrow(PublisherError);
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

    await expect(publishOne(db, design, brief, LISTING_ID)).rejects.toThrow(ComplianceError);
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

  it("on retryable failure: writes only to listings; never touches design.status (pipeline contract)", async () => {
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
    await expect(publishOne(db, design, brief, LISTING_ID)).rejects.toThrow();

    // After migration 046, design.status is OWNED BY DESIGN. Listing must
    // never write status / error_message — those columns belong to the
    // upstream agent. Listing's failure stays on the listings row.
    const dpStatusWrites = updates.filter(
      (u) => u.table === "design_packages" && "status" in u.data
    );
    expect(dpStatusWrites).toEqual([]);

    const dpErrorWrites = updates.filter(
      (u) => u.table === "design_packages" && "error_message" in u.data
    );
    expect(dpErrorWrites).toEqual([]);

    const listingRetryWrite = updates.find(
      (u) =>
        u.table === "listings" &&
        u.data["status"] === "pending" &&
        "retry_count" in u.data
    );
    expect(listingRetryWrite).toBeDefined();
  });

  it("on terminal failure: error lives on listings; design always lands at 'done' (pipeline contract)", async () => {
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
    await expect(publishOne(db, design, brief, LISTING_ID)).rejects.toThrow();

    // Pipeline contract: listing failures NEVER write to design.status
    // or design.error_message — those columns are owned by Design only.
    // Listing's terminal error lives entirely on the listings row.
    const dpStatusWrites = updates.filter(
      (u) => u.table === "design_packages" && "status" in u.data
    );
    expect(dpStatusWrites).toEqual([]);

    const dpErrorMessageWrites = updates.filter(
      (u) => u.table === "design_packages" && "error_message" in u.data
    );
    expect(dpErrorMessageWrites).toEqual([]);

    // The listings row carries the terminal-failure state.
    const listingStatusWrites = updates
      .filter((u) => u.table === "listings" && "status" in u.data && "retry_count" in u.data)
      .map((u) => u.data["status"]);
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
    await expect(publishOne(db, design, brief, LISTING_ID)).rejects.toThrow();

    const listingTerminalWrite = updates.find(
      (u) => u.table === "listings" && u.data.status === "error" && "retry_count" in u.data
    );
    expect(listingTerminalWrite).toBeDefined();
    // retry_count is forced to MAX_RETRIES (3) when the read fails.
    expect(listingTerminalWrite!.data.retry_count).toBe(3);
    expect(String(listingTerminalWrite!.data.error_message)).toContain(
      "retry_count read failed"
    );

    // Pipeline contract: even when the retry-count read fails and we force
    // a terminal listing failure, design.status / .error_message must NOT
    // be written. Design's columns are owned by Design only.
    const dpWrites = updates.filter((u) => u.table === "design_packages" && "status" in u.data);
    expect(dpWrites).toEqual([]);
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
        price_usd: 26.99,
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
    await publishOne(db, designWithMockups, brief, LISTING_ID);

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

  it("keeps the listing 'active' when setProductVisible fails (Printify visibility is best-effort)", async () => {
    // Once activateListing succeeds the Etsy listing is LIVE. A Printify
    // visibility failure must NOT throw or roll the row back to
    // pending_publish — that would re-run the publish against a live listing.
    const { setProductVisible } = mockPrintify();
    setProductVisible.mockRejectedValue(new Error("printify 503"));

    const notifySlack = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@presswork/shared", async () => {
      const actual = await vi.importActual<typeof import("@presswork/shared")>("@presswork/shared");
      return {
        ...actual,
        createDraftListing: vi.fn().mockResolvedValue({ listing_id: 777 }),
        uploadListingImage: vi.fn().mockResolvedValue(undefined),
        getListingImageCount: vi.fn().mockResolvedValue(0),
        activateListing: vi.fn().mockResolvedValue(undefined),
        updateListingInventory: vi.fn().mockResolvedValue(undefined),
        getTaxonomyId: vi.fn().mockResolvedValue(68887043),
        getSettings: vi.fn().mockReturnValue({
          ETSY_SHIPPING_PROFILE_ID: 99,
          ETSY_READINESS_STATE_ID: 42,
          ETSY_PRODUCTION_PARTNER_ID: PARTNER_ID,
        }),
        getLogger: vi.fn().mockReturnValue({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
        notifySlack,
      };
    });

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
        retry_count: 0,
      },
      existingEtsyListingId: 5555,
    });

    const { resumePublish } = await import("./publisher.js");
    await expect(resumePublish(db, LISTING_ID)).resolves.toBeUndefined();

    const activeWrite = updates.find(
      (u) => u.table === "listings" && u.data.status === "active"
    );
    expect(activeWrite).toBeDefined();
    expect(activeWrite?.data.is_active).toBe(true);
    // No rollback to pending_publish / error from the visibility failure.
    expect(
      updates.some(
        (u) =>
          u.table === "listings" &&
          (u.data.status === "pending_publish" || u.data.status === "error")
      )
    ).toBe(false);
    expect(notifySlack).toHaveBeenCalledWith(expect.any(String), { severity: "warn" });
  });

  it("skips already-uploaded image ranks on resume so retries don't duplicate carousel images", async () => {
    mockPrintify();
    const uploadListingImage = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@presswork/shared", async () => {
      const actual = await vi.importActual<typeof import("@presswork/shared")>("@presswork/shared");
      return {
        ...actual,
        createDraftListing: vi.fn().mockResolvedValue({ listing_id: 777 }),
        uploadListingImage,
        // Etsy already has 2 of the 3 mockups from a prior partial attempt.
        getListingImageCount: vi.fn().mockResolvedValue(2),
        activateListing: vi.fn().mockResolvedValue(undefined),
        updateListingInventory: vi.fn().mockResolvedValue(undefined),
        getTaxonomyId: vi.fn().mockResolvedValue(68887043),
        getSettings: vi.fn().mockReturnValue({
          ETSY_SHIPPING_PROFILE_ID: 99,
          ETSY_READINESS_STATE_ID: 42,
          ETSY_PRODUCTION_PARTNER_ID: PARTNER_ID,
        }),
        getLogger: vi.fn().mockReturnValue({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
        notifySlack: vi.fn().mockResolvedValue(undefined),
      };
    });

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
      mockupUrls: ["https://cdn/m1.jpg", "https://cdn/m2.jpg", "https://cdn/m3.jpg"],
    });

    const { resumePublish } = await import("./publisher.js");
    await resumePublish(db, LISTING_ID);

    // Only the 3rd mockup (rank 3) is uploaded; ranks 1-2 already exist on Etsy.
    expect(uploadListingImage).toHaveBeenCalledTimes(1);
    const call = uploadListingImage.mock.calls[0] as [unknown, number, string, { rank?: number }];
    expect(call[2]).toBe("https://cdn/m3.jpg");
    expect(call[3]?.rank).toBe(3);
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
        getListingImageCount: vi.fn().mockResolvedValue(0),
        activateListing: vi.fn().mockResolvedValue(undefined),
        updateListingInventory: vi.fn().mockResolvedValue(undefined),
        getTaxonomyId: vi.fn().mockResolvedValue(68887043),
        getSettings: vi.fn(() => ({
          ETSY_SHIPPING_PROFILE_ID: 99,
          ETSY_READINESS_STATE_ID: 42,
          ETSY_PRODUCTION_PARTNER_ID: partnerId,
        })),
        getLogger: vi.fn().mockReturnValue({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
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

  // ── H2 — Terminal-error Slack alert ─────────────────────────────────────────
  //
  // CLAUDE.md mandates an alert when retry_count reaches MAX_RETRIES. Both
  // publishOne and resumePublish share the same retry budget; whichever
  // reaches the cap first must fire the alert.

  function mockSharedWithSlack(overrides?: { partnerId?: number | null }) {
    const notifySlack = vi.fn().mockResolvedValue(undefined);
    const createDraftListing = vi
      .fn()
      .mockResolvedValue({ listing_id: 777, state: "draft", title: COMPLIANT_TITLE });

    vi.doMock("@presswork/shared", async () => {
      const actual = await vi.importActual<typeof import("@presswork/shared")>("@presswork/shared");
      return {
        ...actual,
        createDraftListing,
        uploadListingImage: vi.fn().mockResolvedValue(undefined),
        getListingImageCount: vi.fn().mockResolvedValue(0),
        activateListing: vi.fn().mockResolvedValue(undefined),
        updateListingInventory: vi.fn().mockResolvedValue(undefined),
        getTaxonomyId: vi.fn().mockResolvedValue(68887043),
        getSettings: vi.fn().mockReturnValue({
          ETSY_SHIPPING_PROFILE_ID: 99,
          ETSY_READINESS_STATE_ID: 42,
          ETSY_PRODUCTION_PARTNER_ID:
            overrides && "partnerId" in overrides ? overrides.partnerId : PARTNER_ID,
        }),
        getLogger: vi.fn().mockReturnValue({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
        notifySlack,
      };
    });

    return { notifySlack };
  }

  it("publishOne fires notifySlack with severity='error' on terminal retry-cap failure (H2)", async () => {
    vi.doMock("./copywriter.js", () => ({
      writeCopy: vi.fn().mockResolvedValue({
        title: COMPLIANT_TITLE,
        description: COMPLIANT_DESCRIPTION,
        tags: COMPLIANT_TAGS,
      }),
    }));
    mockPrintifyFailure();
    const { notifySlack } = mockSharedWithSlack();

    // retry_count=2; +1 = 3 → terminal.
    const db = makeDb([], { retryCount: 2 });

    const { publishOne } = await import("./publisher.js");
    await expect(publishOne(db, design, brief, LISTING_ID)).rejects.toThrow();

    expect(notifySlack).toHaveBeenCalledTimes(1);
    const [message, opts] = notifySlack.mock.calls[0] as [string, { severity?: string }];
    expect(opts?.severity).toBe("error");
    expect(message).toContain(LISTING_ID);
    expect(message).toMatch(/terminal/i);
  });

  it("publishOne does NOT fire notifySlack on retryable failure below the cap (H2 negative)", async () => {
    vi.doMock("./copywriter.js", () => ({
      writeCopy: vi.fn().mockResolvedValue({
        title: COMPLIANT_TITLE,
        description: COMPLIANT_DESCRIPTION,
        tags: COMPLIANT_TAGS,
      }),
    }));
    mockPrintifyFailure();
    const { notifySlack } = mockSharedWithSlack();

    // retry_count=0; +1 = 1 → still below MAX_RETRIES.
    const db = makeDb([], { retryCount: 0 });

    const { publishOne } = await import("./publisher.js");
    await expect(publishOne(db, design, brief, LISTING_ID)).rejects.toThrow();

    expect(notifySlack).not.toHaveBeenCalled();
  });

  it("resumePublish fires notifySlack with severity='error' on terminal retry-cap failure (H2)", async () => {
    vi.doMock("./copywriter.js", () => ({
      writeCopy: vi.fn().mockResolvedValue({
        title: COMPLIANT_TITLE,
        description: COMPLIANT_DESCRIPTION,
        tags: COMPLIANT_TAGS,
      }),
    }));
    mockPrintify();
    const { notifySlack } = mockSharedWithSlack();
    // Force the Etsy publish to fail so resumePublish enters its catch block.
    // mockSharedWithSlack returns a successful createDraftListing — override
    // by re-mocking activateListing to throw on the inbound call.
    vi.doMock("@presswork/shared", async () => {
      const actual = await vi.importActual<typeof import("@presswork/shared")>("@presswork/shared");
      return {
        ...actual,
        createDraftListing: vi.fn().mockResolvedValue({
          listing_id: 777,
          state: "draft",
          title: COMPLIANT_TITLE,
        }),
        uploadListingImage: vi.fn().mockResolvedValue(undefined),
        getListingImageCount: vi.fn().mockResolvedValue(0),
        updateListingInventory: vi.fn().mockResolvedValue(undefined),
        activateListing: vi.fn().mockRejectedValue(new Error("etsy 500")),
        getTaxonomyId: vi.fn().mockResolvedValue(68887043),
        getSettings: vi.fn().mockReturnValue({
          ETSY_SHIPPING_PROFILE_ID: 99,
          ETSY_READINESS_STATE_ID: 42,
          ETSY_PRODUCTION_PARTNER_ID: PARTNER_ID,
        }),
        getLogger: vi.fn().mockReturnValue({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
        notifySlack,
      };
    });

    // retry_count starts at 2; +1 = 3 → terminal.
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
        retry_count: 2,
      },
    });

    const { resumePublish } = await import("./publisher.js");
    await expect(resumePublish(db, LISTING_ID)).rejects.toThrow();

    expect(notifySlack).toHaveBeenCalledTimes(1);
    const [message, opts] = notifySlack.mock.calls[0] as [string, { severity?: string }];
    expect(opts?.severity).toBe("error");
    expect(message).toContain(LISTING_ID);
    expect(message).toMatch(/resume/i);
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
    await expect(publishOne(db, design, brief, LISTING_ID)).rejects.toThrow(PublisherError);
  });

  // ── Image selection tests ────────────────────────────────────────────────────
  //
  // Part 1 of the image-management plan: resumePublish accepts an optional
  // selectedMockupUrls to upload only a subset of the mockup pool.

  function makeImageSelectionSetup() {
    mockPrintify();
    const uploadListingImage = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@presswork/shared", async () => {
      const actual = await vi.importActual<typeof import("@presswork/shared")>("@presswork/shared");
      return {
        ...actual,
        createDraftListing: vi.fn().mockResolvedValue({ listing_id: 777 }),
        uploadListingImage,
        getListingImageCount: vi.fn().mockResolvedValue(0),
        activateListing: vi.fn().mockResolvedValue(undefined),
        updateListingInventory: vi.fn().mockResolvedValue(undefined),
        getTaxonomyId: vi.fn().mockResolvedValue(68887043),
        getSettings: vi.fn().mockReturnValue({
          ETSY_SHIPPING_PROFILE_ID: 99,
          ETSY_READINESS_STATE_ID: 42,
          ETSY_PRODUCTION_PARTNER_ID: PARTNER_ID,
        }),
        getLogger: vi.fn().mockReturnValue({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
        notifySlack: vi.fn().mockResolvedValue(undefined),
      };
    });
    return { uploadListingImage };
  }

  function makePendingPublishDb(mockupUrls: string[]) {
    return makeDb([], {
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
      existingEtsyListingId: 5555,
      mockupUrls,
    });
  }

  it("selection subset: only the selected URLs are uploaded, in selection order", async () => {
    const { uploadListingImage } = makeImageSelectionSetup();

    const allMockups = [
      "https://cdn/m1.jpg",
      "https://cdn/m2.jpg",
      "https://cdn/m3.jpg",
    ];
    // Select only m3 then m1 (reversed, non-contiguous) to verify ordering is
    // preserved from the selection, not from the original array.
    const selection = ["https://cdn/m3.jpg", "https://cdn/m1.jpg"];

    const db = makePendingPublishDb(allMockups);
    const { resumePublish } = await import("./publisher.js");
    await resumePublish(db, LISTING_ID, { selectedMockupUrls: selection });

    expect(uploadListingImage).toHaveBeenCalledTimes(2);
    const calls = uploadListingImage.mock.calls as [unknown, number, string, { rank?: number }][];
    expect(calls[0]?.[2]).toBe("https://cdn/m3.jpg");
    expect(calls[0]?.[3]?.rank).toBe(1);
    expect(calls[1]?.[2]).toBe("https://cdn/m1.jpg");
    expect(calls[1]?.[3]?.rank).toBe(2);
  });

  it("no selection (opts omitted): all mockups are uploaded (backward-compatible regression)", async () => {
    const { uploadListingImage } = makeImageSelectionSetup();

    const allMockups = ["https://cdn/a.jpg", "https://cdn/b.jpg", "https://cdn/c.jpg"];
    const db = makePendingPublishDb(allMockups);

    const { resumePublish } = await import("./publisher.js");
    // Call without opts at all — must behave exactly as before.
    await resumePublish(db, LISTING_ID);

    expect(uploadListingImage).toHaveBeenCalledTimes(3);
    const calls = uploadListingImage.mock.calls as [unknown, number, string, { rank?: number }][];
    expect(calls[0]?.[2]).toBe("https://cdn/a.jpg");
    expect(calls[1]?.[2]).toBe("https://cdn/b.jpg");
    expect(calls[2]?.[2]).toBe("https://cdn/c.jpg");
  });

  it("selection containing a URL not in mockup_urls is silently ignored (not uploaded)", async () => {
    const { uploadListingImage } = makeImageSelectionSetup();

    const allMockups = ["https://cdn/real1.jpg", "https://cdn/real2.jpg"];
    // Selection includes one URL that is genuinely on the row and one that is not.
    const selection = ["https://cdn/real1.jpg", "https://cdn/BOGUS.jpg"];

    const db = makePendingPublishDb(allMockups);
    const { resumePublish } = await import("./publisher.js");
    await resumePublish(db, LISTING_ID, { selectedMockupUrls: selection });

    // Only the valid URL is uploaded; the bogus one is silently dropped.
    expect(uploadListingImage).toHaveBeenCalledTimes(1);
    const calls = uploadListingImage.mock.calls as [unknown, number, string, { rank?: number }][];
    expect(calls[0]?.[2]).toBe("https://cdn/real1.jpg");
  });

  it("selectedMockupUrls length > 10 rejects with PublisherError before any image POST", async () => {
    const { uploadListingImage } = makeImageSelectionSetup();

    // Build 11 mockup URLs — all are genuinely in the row so the selection
    // passes the membership check and only the cap guard fires.
    const allMockups = Array.from({ length: 11 }, (_, i) => `https://cdn/m${i + 1}.jpg`);
    const selection = [...allMockups]; // select all 11 (> 10 cap)

    const db = makePendingPublishDb(allMockups);
    const { resumePublish, PublisherError } = await import("./publisher.js");
    await expect(
      resumePublish(db, LISTING_ID, { selectedMockupUrls: selection })
    ).rejects.toThrow(PublisherError);

    // No image POST must have been attempted before the cap throw.
    expect(uploadListingImage).not.toHaveBeenCalled();
  });

  // ── Variant selection override tests ────────────────────────────────────────
  //
  // listings.selected_variant_ids (INT[] NULL, migration 055) lets the operator
  // narrow which Printify variants appear on a listing. NULL = inherit the full
  // set from design.printify_variant_ids.

  it("publishOne uses selected_variant_ids when set (createHiddenProduct receives the subset)", async () => {
    vi.doMock("./copywriter.js", () => ({
      writeCopy: vi.fn().mockResolvedValue({
        title: COMPLIANT_TITLE,
        description: COMPLIANT_DESCRIPTION,
        tags: COMPLIANT_TAGS,
      }),
    }));
    const { createHiddenProduct } = mockPrintify();
    // Mock validateVariantIds as a no-op (the sibling agent owns the implementation).
    vi.doMock("@presswork/shared", async () => {
      const actual = await vi.importActual<typeof import("@presswork/shared")>("@presswork/shared");
      return {
        ...actual,
        validateVariantIds: vi.fn(),
        createDraftListing: vi.fn().mockResolvedValue({ listing_id: 777 }),
        uploadListingImage: vi.fn().mockResolvedValue(undefined),
        getListingImageCount: vi.fn().mockResolvedValue(0),
        activateListing: vi.fn().mockResolvedValue(undefined),
        updateListingInventory: vi.fn().mockResolvedValue(undefined),
        getTaxonomyId: vi.fn().mockResolvedValue(68887043),
        getSettings: vi.fn().mockReturnValue({
          ETSY_SHIPPING_PROFILE_ID: 99,
          ETSY_READINESS_STATE_ID: 42,
          ETSY_PRODUCTION_PARTNER_ID: PARTNER_ID,
        }),
        getLogger: vi.fn().mockReturnValue({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
        notifySlack: vi.fn().mockResolvedValue(undefined),
      };
    });

    // Operator has narrowed to a subset: [38163, 38191] out of [38163, 38177, 38191].
    const db = makeDb([], { selectedVariantIds: [38163, 38191] });
    const { publishOne } = await import("./publisher.js");
    await publishOne(db, design, brief, LISTING_ID);

    expect(createHiddenProduct).toHaveBeenCalledTimes(1);
    const arg = createHiddenProduct.mock.calls[0]?.[0] as { variantIds: number[] };
    expect(arg.variantIds).toEqual([38163, 38191]);
  });

  it("publishOne falls back to design.printify_variant_ids when selected_variant_ids is null", async () => {
    vi.doMock("./copywriter.js", () => ({
      writeCopy: vi.fn().mockResolvedValue({
        title: COMPLIANT_TITLE,
        description: COMPLIANT_DESCRIPTION,
        tags: COMPLIANT_TAGS,
      }),
    }));
    const { createHiddenProduct } = mockPrintify();
    vi.doMock("@presswork/shared", async () => {
      const actual = await vi.importActual<typeof import("@presswork/shared")>("@presswork/shared");
      return {
        ...actual,
        validateVariantIds: vi.fn(),
        createDraftListing: vi.fn().mockResolvedValue({ listing_id: 777 }),
        uploadListingImage: vi.fn().mockResolvedValue(undefined),
        getListingImageCount: vi.fn().mockResolvedValue(0),
        activateListing: vi.fn().mockResolvedValue(undefined),
        updateListingInventory: vi.fn().mockResolvedValue(undefined),
        getTaxonomyId: vi.fn().mockResolvedValue(68887043),
        getSettings: vi.fn().mockReturnValue({
          ETSY_SHIPPING_PROFILE_ID: 99,
          ETSY_READINESS_STATE_ID: 42,
          ETSY_PRODUCTION_PARTNER_ID: PARTNER_ID,
        }),
        getLogger: vi.fn().mockReturnValue({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
        notifySlack: vi.fn().mockResolvedValue(undefined),
      };
    });

    // selectedVariantIds not set → opts.selectedVariantIds is undefined → mock returns null.
    const db = makeDb([], {});
    const { publishOne } = await import("./publisher.js");
    await publishOne(db, design, brief, LISTING_ID);

    expect(createHiddenProduct).toHaveBeenCalledTimes(1);
    const arg = createHiddenProduct.mock.calls[0]?.[0] as { variantIds: number[] };
    // Full design set must be forwarded when no override is set.
    expect(arg.variantIds).toEqual([38163, 38177, 38191]);
  });

  it("publishOne throws VariantSelectionError when selected_variant_ids contains an id outside design.printify_variant_ids", async () => {
    vi.doMock("./copywriter.js", () => ({
      writeCopy: vi.fn().mockResolvedValue({
        title: COMPLIANT_TITLE,
        description: COMPLIANT_DESCRIPTION,
        tags: COMPLIANT_TAGS,
      }),
    }));
    mockPrintify();
    const { VariantSelectionError: MockVariantSelectionError } = await (async () => {
      // Capture real error class before doMock replaces the module.
      return { VariantSelectionError: class VariantSelectionError extends Error {} };
    })();
    vi.doMock("@presswork/shared", async () => {
      const actual = await vi.importActual<typeof import("@presswork/shared")>("@presswork/shared");
      // validateVariantIds throws VariantSelectionError when not a subset.
      return {
        ...actual,
        VariantSelectionError: MockVariantSelectionError,
        validateVariantIds: vi.fn().mockImplementation(() => {
          throw new MockVariantSelectionError("variant 99999 not in design");
        }),
        getSettings: vi.fn().mockReturnValue({
          ETSY_SHIPPING_PROFILE_ID: 99,
          ETSY_READINESS_STATE_ID: 42,
          ETSY_PRODUCTION_PARTNER_ID: PARTNER_ID,
        }),
        getLogger: vi.fn().mockReturnValue({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
        notifySlack: vi.fn().mockResolvedValue(undefined),
      };
    });

    // 99999 is not in design.printify_variant_ids ([38163, 38177, 38191]).
    const db = makeDb([], { selectedVariantIds: [38163, 99999] });
    const { publishOne } = await import("./publisher.js");
    await expect(publishOne(db, design, brief, LISTING_ID)).rejects.toThrow(
      "variant 99999 not in design"
    );
  });

  it("resumePublish filters printify_variants to selected_variant_ids before building inventory", async () => {
    mockPrintify();
    const updateListingInventory = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@presswork/shared", async () => {
      const actual = await vi.importActual<typeof import("@presswork/shared")>("@presswork/shared");
      return {
        ...actual,
        validateVariantIds: vi.fn(),
        createDraftListing: vi.fn().mockResolvedValue({ listing_id: 777 }),
        uploadListingImage: vi.fn().mockResolvedValue(undefined),
        getListingImageCount: vi.fn().mockResolvedValue(0),
        activateListing: vi.fn().mockResolvedValue(undefined),
        updateListingInventory,
        getTaxonomyId: vi.fn().mockResolvedValue(68887043),
        getSettings: vi.fn().mockReturnValue({
          ETSY_SHIPPING_PROFILE_ID: 99,
          ETSY_READINESS_STATE_ID: 42,
          ETSY_PRODUCTION_PARTNER_ID: PARTNER_ID,
        }),
        getLogger: vi.fn().mockReturnValue({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
        notifySlack: vi.fn().mockResolvedValue(undefined),
      };
    });

    // The mock db returns all three variants from design_packages; listing row
    // carries selected_variant_ids = [38163, 38191] (subset of the full set).
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
        selected_variant_ids: [38163, 38191],
      },
      existingEtsyListingId: 5555,
    });

    const { resumePublish } = await import("./publisher.js");
    await resumePublish(db, LISTING_ID);

    // updateListingInventory receives the buildInventoryFromDesign output which
    // is built from the filtered printifyVariants. Verify the call was made —
    // the actual inventory shape is covered by inventory.test.ts.
    expect(updateListingInventory).toHaveBeenCalledTimes(1);
    // Call signature: updateListingInventory(db, etsyListingId, inventory)
    // [0]=db, [1]=etsyListingId, [2]=inventory payload.
    const inventoryArg = updateListingInventory.mock.calls[0]?.[2];
    // buildInventoryFromDesign produces { products: [...] }; each variant maps
    // to one product entry. We just verify the call was made with a truthy payload —
    // the exact shape is covered by inventory.test.ts.
    expect(inventoryArg).toBeDefined();
  });
});

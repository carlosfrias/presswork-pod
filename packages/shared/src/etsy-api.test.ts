import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

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
};

const RECEIPT_RESPONSE = {
  receipt_id: 42,
  buyer_user_id: 1,
  name: "Jane Doe",
  first_line: "123 Main St",
  city: "Portland",
  state: "OR",
  zip: "97201",
  country_iso: "US",
  grandtotal: { amount: 2499, divisor: 100, currency_code: "USD" },
  transactions: [{ listing_id: 123, quantity: 1, price: { amount: 2499, divisor: 100, currency_code: "USD" } }],
};

const server = setupServer();
beforeEach(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => { server.resetHandlers(); server.close(); });

describe("getReceipt", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, validEnv);
  });

  afterEach(() => { process.env = savedEnv; });

  it("returns parsed receipt on 200", async () => {
    vi.doMock("./etsy-auth.js", () => ({
      getValidAccessToken: vi.fn().mockResolvedValue("test-token"),
      EtsyAuthError: class EtsyAuthError extends Error {},
    }));
    server.use(
      http.get("https://openapi.etsy.com/v3/application/shops/99/receipts/42", () =>
        HttpResponse.json(RECEIPT_RESPONSE)
      )
    );
    const { getReceipt } = await import("./etsy-api.js");
    const receipt = await getReceipt({} as never, 42);
    expect(receipt.receipt_id).toBe(42);
    expect(receipt.transactions).toHaveLength(1);
  });

  it("retries on 429 and succeeds", async () => {
    vi.doMock("./etsy-auth.js", () => ({
      getValidAccessToken: vi.fn().mockResolvedValue("test-token"),
      EtsyAuthError: class EtsyAuthError extends Error {},
    }));
    let attempts = 0;
    server.use(
      http.get("https://openapi.etsy.com/v3/application/shops/99/receipts/42", () => {
        attempts++;
        if (attempts < 3) return new HttpResponse("rate limited", { status: 429 });
        return HttpResponse.json(RECEIPT_RESPONSE);
      })
    );
    const { getReceipt } = await import("./etsy-api.js");
    const receipt = await getReceipt({} as never, 42);
    expect(receipt.receipt_id).toBe(42);
    expect(attempts).toBe(3);
  });

  it("honors Retry-After on 429 (bug #17)", async () => {
    vi.doMock("./etsy-auth.js", () => ({
      getValidAccessToken: vi.fn().mockResolvedValue("test-token"),
      EtsyAuthError: class EtsyAuthError extends Error {},
    }));
    let attempts = 0;
    let firstAttemptAt = 0;
    let secondAttemptAt = 0;
    server.use(
      http.get("https://openapi.etsy.com/v3/application/shops/99/receipts/42", () => {
        attempts++;
        if (attempts === 1) {
          firstAttemptAt = Date.now();
          return new HttpResponse("slow down", {
            status: 429,
            headers: { "Retry-After": "1" },
          });
        }
        secondAttemptAt = Date.now();
        return HttpResponse.json(RECEIPT_RESPONSE);
      })
    );
    const { getReceipt } = await import("./etsy-api.js");
    const receipt = await getReceipt({} as never, 42);
    expect(receipt.receipt_id).toBe(42);
    expect(attempts).toBe(2);
    // Retry-After: 1s — second attempt must wait at least ~900ms after first.
    expect(secondAttemptAt - firstAttemptAt).toBeGreaterThanOrEqual(900);
  });

  it("surfaces 4xx (non-401, non-429) immediately without retrying", async () => {
    vi.doMock("./etsy-auth.js", () => ({
      getValidAccessToken: vi.fn().mockResolvedValue("test-token"),
      EtsyAuthError: class EtsyAuthError extends Error {},
    }));
    let attempts = 0;
    server.use(
      http.get("https://openapi.etsy.com/v3/application/shops/99/receipts/42", () => {
        attempts++;
        return new HttpResponse("not found", { status: 404 });
      })
    );
    const { getReceipt, EtsyApiError } = await import("./etsy-api.js");
    await expect(getReceipt({} as never, 42)).rejects.toThrow(EtsyApiError);
    expect(attempts).toBe(1);
  });
});

describe("listReceipts", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, validEnv);
  });

  afterEach(() => { process.env = savedEnv; });

  it("returns array from results field", async () => {
    vi.doMock("./etsy-auth.js", () => ({
      getValidAccessToken: vi.fn().mockResolvedValue("test-token"),
      EtsyAuthError: class EtsyAuthError extends Error {},
    }));
    server.use(
      http.get("https://openapi.etsy.com/v3/application/shops/99/receipts", () =>
        HttpResponse.json({ results: [RECEIPT_RESPONSE] })
      )
    );
    const { listReceipts } = await import("./etsy-api.js");
    const receipts = await listReceipts({} as never, { was_paid: true, was_shipped: false });
    expect(receipts).toHaveLength(1);
  });
});

const LISTING_RESPONSE = {
  listing_id: 999,
  state: "draft",
  title: "Cat Tee",
};

const LISTING_INPUT = {
  taxonomy_id: 2078,
  who_made: "i_did" as const,
  when_made: "made_to_order",
  is_supply: false,
  shipping_profile_id: 123,
  // Required by Etsy on create (Missing input parameter: [quantity] otherwise).
  quantity: 999,
  // Required by Etsy POD policy (compliance rule 1). Schema rejects empty/missing.
  production_partner_ids: [999001],
  readiness_state_id: 1,
  title: "Cat Tee",
  description: "A great shirt. This design was created using AI image generation tools, hand-selected and quality-reviewed by our team before printing.",
  price: 24.99,
  tags: ["cat shirt", "cat tee", "funny cat", "cat lover", "unisex",
         "graphic tee", "cat mom", "cat dad", "pet lover", "animal",
         "cute cat", "cat design", "novelty"],
};

describe("createDraftListing", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, validEnv);
  });

  afterEach(() => { process.env = savedEnv; });

  it("posts to listings endpoint and returns listing_id", async () => {
    vi.doMock("./etsy-auth.js", () => ({
      getValidAccessToken: vi.fn().mockResolvedValue("test-token"),
      EtsyAuthError: class EtsyAuthError extends Error {},
    }));
    server.use(
      http.post("https://openapi.etsy.com/v3/application/shops/99/listings", () =>
        HttpResponse.json(LISTING_RESPONSE)
      )
    );
    const { createDraftListing } = await import("./etsy-api.js");
    const result = await createDraftListing({} as never, LISTING_INPUT);
    expect(result.listing_id).toBe(999);
  });

  it("surfaces 4xx as EtsyApiError without retrying", async () => {
    vi.doMock("./etsy-auth.js", () => ({
      getValidAccessToken: vi.fn().mockResolvedValue("test-token"),
      EtsyAuthError: class EtsyAuthError extends Error {},
    }));
    let attempts = 0;
    server.use(
      http.post("https://openapi.etsy.com/v3/application/shops/99/listings", () => {
        attempts++;
        return new HttpResponse("bad request", { status: 400 });
      })
    );
    const { createDraftListing, EtsyApiError } = await import("./etsy-api.js");
    await expect(createDraftListing({} as never, LISTING_INPUT)).rejects.toThrow(EtsyApiError);
    expect(attempts).toBe(1);
  });
});

describe("uploadListingImage download guards (audit #40)", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, validEnv);
  });

  afterEach(() => { process.env = savedEnv; });

  it("times out when image download stalls", async () => {
    vi.doMock("./etsy-auth.js", () => ({
      getValidAccessToken: vi.fn().mockResolvedValue("test-token"),
      EtsyAuthError: class EtsyAuthError extends Error {},
    }));
    server.use(
      http.get("https://example.com/slow-mockup.png", async ({ request }) => {
        // Wait until the AbortController fires; the test sets timeoutMs short.
        await new Promise<void>((resolve) => {
          request.signal.addEventListener("abort", () => resolve());
        });
        return new HttpResponse(null, { status: 504 });
      })
    );
    const { uploadListingImage, EtsyApiError } = await import("./etsy-api.js");
    await expect(
      uploadListingImage({} as never, 1, "https://example.com/slow-mockup.png", {
        timeoutMs: 50,
      })
    ).rejects.toThrow(EtsyApiError);
  });

  it("rejects non-image content-type", async () => {
    vi.doMock("./etsy-auth.js", () => ({
      getValidAccessToken: vi.fn().mockResolvedValue("test-token"),
      EtsyAuthError: class EtsyAuthError extends Error {},
    }));
    server.use(
      http.get("https://example.com/not-an-image.html", () =>
        new HttpResponse("<html>oops</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        })
      )
    );
    const { uploadListingImage, EtsyApiError } = await import("./etsy-api.js");
    await expect(
      uploadListingImage({} as never, 1, "https://example.com/not-an-image.html")
    ).rejects.toThrow(EtsyApiError);
  });

  it("accepts a generic binary content-type when the URL has an image extension (Dynamic Mockups S3)", async () => {
    vi.doMock("./etsy-auth.js", () => ({
      getValidAccessToken: vi.fn().mockResolvedValue("test-token"),
      EtsyAuthError: class EtsyAuthError extends Error {},
    }));
    const dmUrl =
      "https://app-dynamicmockups-psd-engine-production.s3.eu-central-1.amazonaws.com/variation-exports/abc.jpg";
    let uploadHit = false;
    server.use(
      // S3 serves a real JPEG but with a generic content-type.
      http.get(dmUrl, () =>
        new HttpResponse("fake-jpeg-bytes", {
          status: 200,
          headers: { "Content-Type": "binary/octet-stream" },
        })
      ),
      http.post(
        "https://openapi.etsy.com/v3/application/shops/:shopId/listings/:listingId/images",
        () => {
          uploadHit = true;
          return HttpResponse.json({ listing_image_id: 1, rank: 1 });
        }
      )
    );
    const { uploadListingImage } = await import("./etsy-api.js");
    await uploadListingImage({} as never, 1, dmUrl);
    expect(uploadHit).toBe(true);
  });

  it("still rejects a generic binary content-type when the URL has no image extension", async () => {
    vi.doMock("./etsy-auth.js", () => ({
      getValidAccessToken: vi.fn().mockResolvedValue("test-token"),
      EtsyAuthError: class EtsyAuthError extends Error {},
    }));
    server.use(
      http.get("https://example.com/mystery-blob", () =>
        new HttpResponse("data", {
          status: 200,
          headers: { "Content-Type": "binary/octet-stream" },
        })
      )
    );
    const { uploadListingImage, EtsyApiError } = await import("./etsy-api.js");
    await expect(
      uploadListingImage({} as never, 1, "https://example.com/mystery-blob")
    ).rejects.toThrow(EtsyApiError);
  });

  it("rejects when Content-Length exceeds max", async () => {
    vi.doMock("./etsy-auth.js", () => ({
      getValidAccessToken: vi.fn().mockResolvedValue("test-token"),
      EtsyAuthError: class EtsyAuthError extends Error {},
    }));
    server.use(
      http.get("https://example.com/huge.png", () =>
        new HttpResponse("x", {
          status: 200,
          headers: {
            "Content-Type": "image/png",
            "Content-Length": "999999999",
          },
        })
      )
    );
    const { uploadListingImage, EtsyApiError } = await import("./etsy-api.js");
    await expect(
      uploadListingImage({} as never, 1, "https://example.com/huge.png", {
        maxBytes: 1024,
      })
    ).rejects.toThrow(/exceeds max size/);
    // Wrap in a second await to satisfy lint and confirm error class.
    await expect(
      uploadListingImage({} as never, 1, "https://example.com/huge.png", {
        maxBytes: 1024,
      })
    ).rejects.toThrow(EtsyApiError);
  });
});

describe("activateListing", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, validEnv);
  });

  afterEach(() => { process.env = savedEnv; });

  it("patches listing to active state", async () => {
    vi.doMock("./etsy-auth.js", () => ({
      getValidAccessToken: vi.fn().mockResolvedValue("test-token"),
      EtsyAuthError: class EtsyAuthError extends Error {},
    }));
    let capturedBody: unknown;
    server.use(
      http.patch("https://openapi.etsy.com/v3/application/shops/99/listings/999", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ ...LISTING_RESPONSE, state: "active" });
      })
    );
    const { activateListing } = await import("./etsy-api.js");
    await activateListing({} as never, 999);
    expect(capturedBody).toMatchObject({ state: "active" });
  });

  it("surfaces 4xx as EtsyApiError", async () => {
    vi.doMock("./etsy-auth.js", () => ({
      getValidAccessToken: vi.fn().mockResolvedValue("test-token"),
      EtsyAuthError: class EtsyAuthError extends Error {},
    }));
    server.use(
      http.patch("https://openapi.etsy.com/v3/application/shops/99/listings/999", () =>
        new HttpResponse("forbidden", { status: 403 })
      )
    );
    const { activateListing, EtsyApiError } = await import("./etsy-api.js");
    await expect(activateListing({} as never, 999)).rejects.toThrow(EtsyApiError);
  });
});

describe("getActiveEtsyListings", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, validEnv);
  });

  afterEach(() => { process.env = savedEnv; });

  it("normalizes price (amount/divisor) and tags, and stops after one page", async () => {
    vi.doMock("./etsy-auth.js", () => ({
      getValidAccessToken: vi.fn().mockResolvedValue("test-token"),
      EtsyAuthError: class EtsyAuthError extends Error {},
    }));
    let calls = 0;
    server.use(
      http.get("https://openapi.etsy.com/v3/application/shops/99/listings/active", () => {
        calls++;
        return HttpResponse.json({
          count: 2,
          results: [
            {
              listing_id: 111,
              title: "Live One",
              description: "desc",
              tags: ["a", "b"],
              state: "active",
              price: { amount: 2499, divisor: 100, currency_code: "USD" },
            },
            {
              listing_id: 222,
              title: "Live Two",
              description: null,
              tags: null,
              state: "active",
            },
          ],
        });
      })
    );
    const { getActiveEtsyListings } = await import("./etsy-api.js");
    const live = await getActiveEtsyListings({} as never);
    expect(calls).toBe(1); // count === results.length → no second page
    expect(live).toEqual([
      { etsyListingId: 111, title: "Live One", description: "desc", tags: ["a", "b"], price: 24.99, currency: "USD" },
      { etsyListingId: 222, title: "Live Two", description: null, tags: [], price: null, currency: null },
    ]);
  });

  it("follows pagination until count is reached", async () => {
    vi.doMock("./etsy-auth.js", () => ({
      getValidAccessToken: vi.fn().mockResolvedValue("test-token"),
      EtsyAuthError: class EtsyAuthError extends Error {},
    }));
    server.use(
      http.get("https://openapi.etsy.com/v3/application/shops/99/listings/active", ({ request }) => {
        const offset = Number(new URL(request.url).searchParams.get("offset"));
        const result = (id: number) => ({
          listing_id: id,
          title: `L${id}`,
          state: "active",
          price: { amount: 1000, divisor: 100, currency_code: "USD" },
        });
        // count=3: first page returns 2 (offset 0), second returns 1 (offset 100).
        return HttpResponse.json({
          count: 3,
          results: offset === 0 ? [result(1), result(2)] : [result(3)],
        });
      })
    );
    const { getActiveEtsyListings } = await import("./etsy-api.js");
    const live = await getActiveEtsyListings({} as never);
    expect(live.map((l) => l.etsyListingId)).toEqual([1, 2, 3]);
  });
});

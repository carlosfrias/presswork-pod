import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

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
  PRINTIFY_SHOP_ID: "shop-99",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  RESEND_API_KEY: "resend-key",
  ALERT_EMAIL: "alert@example.com",
  SLACK_WEBHOOK_URL: "https://hooks.slack.com/test",
  NODE_ENV: "test",
  LOG_LEVEL: "info",
  HUMAN_REVIEW_ENABLED: "true",
};

const INPUT = {
  imageUrl: "https://cdn.supabase.co/designs/abc123.png",
  blueprintId: 145,
  printProviderId: 3,
  variantIds: [38163, 38177, 38191],
  title: "Test T-Shirt",
};

const UPLOAD_ID = "upload-xyz-789";

const PRODUCT_RESPONSE = {
  id: "product-abc",
  images: [
    { src: "https://printify.com/mockup1.jpg" },
    { src: "https://printify.com/mockup2.jpg" },
  ],
};

const server = setupServer();

beforeEach(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => { server.resetHandlers(); server.close(); });

describe("createHiddenProduct (two-step upload then create)", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, validEnv);
  });

  afterEach(() => { process.env = savedEnv; });

  it("uploads the image first, then creates a product referencing the upload id", async () => {
    let uploadCalls = 0;
    let productCalls = 0;
    let capturedUpload: unknown;
    let capturedProduct: unknown;
    let firstCall: "upload" | "product" | undefined;

    server.use(
      http.post("https://api.printify.com/v1/uploads/images.json", async ({ request }) => {
        uploadCalls++;
        if (!firstCall) firstCall = "upload";
        capturedUpload = await request.json();
        return HttpResponse.json({ id: UPLOAD_ID });
      }),
      http.post("https://api.printify.com/v1/shops/shop-99/products.json", async ({ request }) => {
        productCalls++;
        if (!firstCall) firstCall = "product";
        capturedProduct = await request.json();
        return HttpResponse.json(PRODUCT_RESPONSE);
      })
    );

    const { createHiddenProduct } = await import("./printify.js");
    const result = await createHiddenProduct(INPUT);

    expect(firstCall).toBe("upload");
    expect(uploadCalls).toBe(1);
    expect(productCalls).toBe(1);

    // Upload body should reference the URL — Printify pulls the bytes itself.
    expect(capturedUpload).toMatchObject({ url: INPUT.imageUrl });
    expect((capturedUpload as { file_name: string }).file_name).toBe("abc123.png");

    // Product body must use the upload id (NOT the public URL) and the
    // print_provider_id passed in by the caller.
    const productBody = capturedProduct as {
      blueprint_id: number;
      print_provider_id: number;
      print_areas: Array<{ placeholders: Array<{ images: Array<{ id: string }> }> }>;
    };
    expect(productBody.blueprint_id).toBe(145);
    expect(productBody.print_provider_id).toBe(3);
    expect(productBody.print_areas[0]?.placeholders[0]?.images[0]?.id).toBe(UPLOAD_ID);

    expect(result.productId).toBe("product-abc");
    expect(result.mockupUrls).toHaveLength(2);
  });

  it("throws PrintifyError when upload returns no id", async () => {
    server.use(
      http.post("https://api.printify.com/v1/uploads/images.json", () =>
        HttpResponse.json({})
      )
    );
    const { createHiddenProduct, PrintifyError } = await import("./printify.js");
    await expect(createHiddenProduct(INPUT)).rejects.toThrow(PrintifyError);
  });

  it("throws PrintifyError when product creation returns empty images array", async () => {
    server.use(
      http.post("https://api.printify.com/v1/uploads/images.json", () =>
        HttpResponse.json({ id: UPLOAD_ID })
      ),
      http.post("https://api.printify.com/v1/shops/shop-99/products.json", () =>
        HttpResponse.json({ id: "product-xyz", images: [] })
      )
    );
    const { createHiddenProduct, PrintifyError } = await import("./printify.js");
    await expect(createHiddenProduct(INPUT)).rejects.toThrow(PrintifyError);
  });

  it("retries on 5xx during product create and eventually succeeds", async () => {
    let productAttempts = 0;
    server.use(
      http.post("https://api.printify.com/v1/uploads/images.json", () =>
        HttpResponse.json({ id: UPLOAD_ID })
      ),
      http.post("https://api.printify.com/v1/shops/shop-99/products.json", () => {
        productAttempts++;
        if (productAttempts < 3) return new HttpResponse("server error", { status: 500 });
        return HttpResponse.json(PRODUCT_RESPONSE);
      })
    );
    const { createHiddenProduct } = await import("./printify.js");
    const result = await createHiddenProduct(INPUT);
    expect(result.productId).toBe("product-abc");
    expect(productAttempts).toBe(3);
  });

  it("surfaces 4xx from product create immediately without retrying", async () => {
    let productAttempts = 0;
    server.use(
      http.post("https://api.printify.com/v1/uploads/images.json", () =>
        HttpResponse.json({ id: UPLOAD_ID })
      ),
      http.post("https://api.printify.com/v1/shops/shop-99/products.json", () => {
        productAttempts++;
        return new HttpResponse("bad request", { status: 400 });
      })
    );
    const { createHiddenProduct, PrintifyError } = await import("./printify.js");
    await expect(createHiddenProduct(INPUT)).rejects.toThrow(PrintifyError);
    expect(productAttempts).toBe(1);
  });
});

describe("setProductVisible", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, validEnv);
  });

  afterEach(() => { process.env = savedEnv; });

  it("issues a PUT with is_visible=true", async () => {
    let capturedBody: unknown;
    server.use(
      http.put("https://api.printify.com/v1/shops/shop-99/products/product-abc.json", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ id: "product-abc" });
      })
    );
    const { setProductVisible } = await import("./printify.js");
    await setProductVisible("product-abc");
    expect(capturedBody).toMatchObject({ is_visible: true });
  });
});

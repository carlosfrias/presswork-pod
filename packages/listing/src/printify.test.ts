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
  imageUrl: "https://cdn.supabase.co/designs/test.png",
  blueprintId: 5,
  variantIds: [1, 2, 3],
  title: "Test T-Shirt",
};

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

describe("createHiddenProduct", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
    Object.assign(process.env, validEnv);
  });

  afterEach(() => { process.env = savedEnv; });

  it("happy path returns product id and mockup URLs", async () => {
    server.use(
      http.post("https://api.printify.com/v1/shops/shop-99/products.json", () =>
        HttpResponse.json(PRODUCT_RESPONSE)
      )
    );
    const { createHiddenProduct } = await import("./printify.js");
    const result = await createHiddenProduct(INPUT);
    expect(result.productId).toBe("product-abc");
    expect(result.mockupUrls).toHaveLength(2);
  });

  it("throws PrintifyError when images array is empty", async () => {
    server.use(
      http.post("https://api.printify.com/v1/shops/shop-99/products.json", () =>
        HttpResponse.json({ id: "product-xyz", images: [] })
      )
    );
    const { createHiddenProduct, PrintifyError } = await import("./printify.js");
    await expect(createHiddenProduct(INPUT)).rejects.toThrow(PrintifyError);
  });

  it("retries on 5xx and eventually succeeds", async () => {
    let attempts = 0;
    server.use(
      http.post("https://api.printify.com/v1/shops/shop-99/products.json", () => {
        attempts++;
        if (attempts < 3) return new HttpResponse("server error", { status: 500 });
        return HttpResponse.json(PRODUCT_RESPONSE);
      })
    );
    const { createHiddenProduct } = await import("./printify.js");
    const result = await createHiddenProduct(INPUT);
    expect(result.productId).toBe("product-abc");
    expect(attempts).toBe(3);
  });

  it("surfaces 4xx immediately without retrying", async () => {
    let attempts = 0;
    server.use(
      http.post("https://api.printify.com/v1/shops/shop-99/products.json", () => {
        attempts++;
        return new HttpResponse("bad request", { status: 400 });
      })
    );
    const { createHiddenProduct, PrintifyError } = await import("./printify.js");
    await expect(createHiddenProduct(INPUT)).rejects.toThrow(PrintifyError);
    expect(attempts).toBe(1);
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

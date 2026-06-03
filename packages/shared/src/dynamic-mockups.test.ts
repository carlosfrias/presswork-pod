import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

// getSettings() parses the full process.env; stub it down to just the DM key.
vi.mock("./config.js", () => ({
  getSettings: () => ({ DYNAMIC_MOCKUPS_API_KEY: "test-key", LOG_LEVEL: "silent" }),
}));

const RENDERS_URL = "https://app.dynamicmockups.com/api/v1/renders";

const server = setupServer();
beforeEach(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  server.close();
});

/** Capture the request body of the next render POST and return a canned URL. */
function captureRender(): { getBody: () => SmartObjectsBody | undefined } {
  let body: SmartObjectsBody | undefined;
  server.use(
    http.post(RENDERS_URL, async ({ request }) => {
      body = (await request.json()) as SmartObjectsBody;
      return HttpResponse.json({
        data: { export_path: "https://cdn.dynamicmockups.example/out.jpg" },
        success: true,
      });
    })
  );
  return { getBody: () => body };
}

interface SmartObjectsBody {
  mockup_uuid: string;
  smart_objects: Array<{ uuid: string; asset?: { url: string }; color?: string }>;
}

describe("renderMockup color handling", () => {
  it("omits color entirely when none is requested", async () => {
    const cap = captureRender();
    const { renderMockup } = await import("./dynamic-mockups.js");

    const url = await renderMockup({
      mockupUuid: "m-uuid",
      smartObjectUuid: "design-so",
      designUrl: "https://cdn.example/design.png",
    });

    expect(url).toBe("https://cdn.dynamicmockups.example/out.jpg");
    const body = cap.getBody()!;
    expect(body.smart_objects).toHaveLength(1);
    expect(body.smart_objects[0]).toEqual({
      uuid: "design-so",
      asset: { url: "https://cdn.example/design.png" },
    });
    expect(body.smart_objects[0]?.color).toBeUndefined();
  });

  it("paints a SEPARATE garment smart object, leaving the design slot clean", async () => {
    const cap = captureRender();
    const { renderMockup } = await import("./dynamic-mockups.js");

    await renderMockup({
      mockupUuid: "m-uuid",
      smartObjectUuid: "design-so",
      designUrl: "https://cdn.example/design.png",
      color: "#1B1B1B",
      colorSmartObjectUuid: "garment-so",
    });

    const body = cap.getBody()!;
    expect(body.smart_objects).toHaveLength(2);
    // Design slot keeps only the asset — no color tint on the artwork.
    expect(body.smart_objects[0]).toEqual({
      uuid: "design-so",
      asset: { url: "https://cdn.example/design.png" },
    });
    // Garment slot carries the color, no asset.
    expect(body.smart_objects[1]).toEqual({ uuid: "garment-so", color: "#1B1B1B" });
  });

  it("falls back to coloring the design slot when no garment slot is given", async () => {
    const cap = captureRender();
    const { renderMockup } = await import("./dynamic-mockups.js");

    await renderMockup({
      mockupUuid: "m-uuid",
      smartObjectUuid: "design-so",
      designUrl: "https://cdn.example/design.png",
      color: "#C8102E",
    });

    const body = cap.getBody()!;
    expect(body.smart_objects).toHaveLength(1);
    expect(body.smart_objects[0]).toEqual({
      uuid: "design-so",
      asset: { url: "https://cdn.example/design.png" },
      color: "#C8102E",
    });
  });

  it("treats a garment uuid equal to the design uuid as the single-slot case", async () => {
    const cap = captureRender();
    const { renderMockup } = await import("./dynamic-mockups.js");

    await renderMockup({
      mockupUuid: "m-uuid",
      smartObjectUuid: "design-so",
      designUrl: "https://cdn.example/design.png",
      color: "#FFFFFF",
      colorSmartObjectUuid: "design-so",
    });

    const body = cap.getBody()!;
    expect(body.smart_objects).toHaveLength(1);
    expect(body.smart_objects[0]?.color).toBe("#FFFFFF");
  });
});

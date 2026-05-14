import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireOwnerEmail: vi.fn(async () => "owner@test.com"),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("generatePalette", () => {
  it("returns 5 hex codes derived from colormind's RGB triples on a 200 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          result: [
            [255, 0, 0],
            [0, 255, 0],
            [0, 0, 255],
            [255, 255, 0],
            [0, 255, 255],
          ],
        }),
      })),
    );
    vi.resetModules();
    const { generatePalette } = await import("./palette");

    const palette = await generatePalette();

    expect(palette).toEqual(["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#00ffff"]);
  });

  it("falls back to the local palette when colormind returns a non-200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
      })),
    );
    vi.resetModules();
    const { generatePalette } = await import("./palette");

    const palette = await generatePalette();

    expect(palette).toHaveLength(5);
    for (const c of palette) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("falls back to the local palette when fetch throws (timeout / network error)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    vi.resetModules();
    const { generatePalette } = await import("./palette");

    const palette = await generatePalette();

    expect(palette).toHaveLength(5);
  });
});

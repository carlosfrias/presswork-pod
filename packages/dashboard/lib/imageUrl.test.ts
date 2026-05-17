import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { withCacheBuster, withDownload, withTransform } from "./imageUrl";

describe("withCacheBuster", () => {
  it("returns null when the url is missing", () => {
    expect(withCacheBuster(null, "v1")).toBeNull();
    expect(withCacheBuster(undefined, "v1")).toBeNull();
  });

  it("returns the url unchanged when no version is provided", () => {
    expect(withCacheBuster("https://cdn.test/design.png", null)).toBe(
      "https://cdn.test/design.png",
    );
    expect(withCacheBuster("https://cdn.test/design.png", undefined)).toBe(
      "https://cdn.test/design.png",
    );
  });

  it("appends ?v=<version> when the url has no existing query string", () => {
    expect(withCacheBuster("https://cdn.test/design.png", 42)).toBe(
      "https://cdn.test/design.png?v=42",
    );
  });

  it("appends &v=<version> when the url already has a query string", () => {
    expect(withCacheBuster("https://cdn.test/design.png?foo=bar", 42)).toBe(
      "https://cdn.test/design.png?foo=bar&v=42",
    );
  });

  it("URL-encodes versions that contain reserved characters", () => {
    expect(withCacheBuster("https://cdn.test/design.png", "2026-05-14T12:00:00Z")).toBe(
      "https://cdn.test/design.png?v=2026-05-14T12%3A00%3A00Z",
    );
  });
});

describe("withTransform", () => {
  const SUPABASE_URL =
    "https://abc123.supabase.co/storage/v1/object/public/designs/uuid.png";
  const TRANSFORM_URL =
    "https://abc123.supabase.co/storage/v1/render/image/public/designs/uuid.png";

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_IMAGE_TRANSFORMS_ENABLED = "true";
  });
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SUPABASE_IMAGE_TRANSFORMS_ENABLED;
  });

  it("returns the original URL when transforms are disabled", () => {
    process.env.NEXT_PUBLIC_SUPABASE_IMAGE_TRANSFORMS_ENABLED = "false";
    expect(withTransform(SUPABASE_URL, { width: 400, quality: 75 })).toBe(SUPABASE_URL);
  });

  it("returns the original URL when the flag is unset", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_IMAGE_TRANSFORMS_ENABLED;
    expect(withTransform(SUPABASE_URL, { width: 400 })).toBe(SUPABASE_URL);
  });

  it("returns null when url is missing", () => {
    expect(withTransform(null, { width: 400 })).toBeNull();
    expect(withTransform(undefined, { width: 400 })).toBeNull();
  });

  it("passes non-Supabase URLs through unchanged", () => {
    const printify = "https://images-api.printify.com/mockup/abc/front.jpg";
    expect(withTransform(printify, { width: 200, quality: 75 })).toBe(printify);
  });

  it("rewrites the path to the render endpoint and adds width", () => {
    const result = withTransform(SUPABASE_URL, { width: 400 });
    expect(result).toContain("/storage/v1/render/image/public/");
    expect(result).toContain("width=400");
    expect(result).not.toContain("/object/public/");
  });

  it("adds quality param when provided", () => {
    const result = withTransform(SUPABASE_URL, { width: 400, quality: 75 });
    expect(result).toBe(`${TRANSFORM_URL}?width=400&quality=75`);
  });

  it("adds height and resize params when provided", () => {
    const result = withTransform(SUPABASE_URL, { width: 400, height: 400, quality: 75, resize: "cover" });
    expect(result).toContain("width=400");
    expect(result).toContain("height=400");
    expect(result).toContain("quality=75");
    expect(result).toContain("resize=cover");
  });

  it("omits quality param when not provided", () => {
    const result = withTransform(SUPABASE_URL, { width: 400 });
    expect(result).toBe(`${TRANSFORM_URL}?width=400`);
  });

  it("preserves existing query params such as the cache buster", () => {
    const busted = `${SUPABASE_URL}?v=2026-05-15T00%3A00%3A00Z`;
    const result = withTransform(busted, { width: 400, quality: 75 });
    expect(result).toContain("v=2026-05-15T00%3A00%3A00Z");
    expect(result).toContain("width=400");
    expect(result).toContain("quality=75");
    expect(result).toContain("/render/image/public/");
  });
});

describe("withDownload", () => {
  it("returns null when the url is missing", () => {
    expect(withDownload(null, "x.png")).toBeNull();
    expect(withDownload(undefined, "x.png")).toBeNull();
  });

  it("appends ?download=<filename> when the url has no existing query", () => {
    expect(
      withDownload("https://cdn.test/design.png", "design-abc.png"),
    ).toBe("https://cdn.test/design.png?download=design-abc.png");
  });

  it("appends &download=<filename> when the url already has a query", () => {
    expect(
      withDownload("https://cdn.test/design.png?v=42", "design-abc.png"),
    ).toBe("https://cdn.test/design.png?v=42&download=design-abc.png");
  });

  it("URL-encodes filenames that contain reserved characters", () => {
    expect(
      withDownload("https://cdn.test/design.png", "name with space.png"),
    ).toBe("https://cdn.test/design.png?download=name%20with%20space.png");
  });
});

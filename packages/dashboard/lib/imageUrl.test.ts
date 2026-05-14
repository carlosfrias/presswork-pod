import { describe, it, expect } from "vitest";
import { withCacheBuster } from "./imageUrl";

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

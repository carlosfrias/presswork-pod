import { describe, it, expect } from "vitest";
import { assertBlueprintSupported, printifyVariantPriceCents } from "./constants.js";

describe("assertBlueprintSupported (audit #53)", () => {
  it("passes for the registered (145, 3) pair", () => {
    expect(() => assertBlueprintSupported(145, 3)).not.toThrow();
  });

  it("throws naming the missing blueprint when the id isn't registered", () => {
    expect(() => assertBlueprintSupported(9999, 3)).toThrow(/Unknown Printify blueprint 9999/);
    expect(() => assertBlueprintSupported(9999, 3)).toThrow(
      /PRINTIFY_BLUEPRINT_PROVIDERS/
    );
  });

  it("throws on (blueprint, provider) pair mismatch", () => {
    expect(() => assertBlueprintSupported(145, 42)).toThrow(
      /does not match the registered pairing/
    );
    expect(() => assertBlueprintSupported(145, 42)).toThrow(/expected provider 3/);
  });
});

describe("printifyVariantPriceCents", () => {
  it("returns the table value for registered blueprints", () => {
    expect(printifyVariantPriceCents(145)).toBe(2499);
  });

  it("falls back to the placeholder cents for unknown blueprints", () => {
    expect(printifyVariantPriceCents(9999)).toBe(100);
  });
});

import { describe, it, expect } from "vitest";
import { computeEtsyFees, lookupPrintCost, UnknownBlueprintError } from "./economics.js";

describe("computeEtsyFees", () => {
  it("matches the specified fee formula for a $24.99 sale", () => {
    // 24.99 * 0.065 + 24.99 * 0.03 + 0.25 + 0.20
    // = 1.62435 + 0.7497 + 0.25 + 0.20 = 2.82405
    const fees = computeEtsyFees(24.99);
    expect(fees).toBeCloseTo(2.82405, 4);
  });

  it("$0 sale → $0.45 (fixed fees only: $0.25 processing + $0.20 listing)", () => {
    const fees = computeEtsyFees(0);
    expect(fees).toBeCloseTo(0.45, 5);
  });

  it("is a pure function with no side effects", () => {
    expect(computeEtsyFees(10)).toBe(computeEtsyFees(10));
  });
});

describe("lookupPrintCost", () => {
  it("returns $8.50 for blueprint 6 (Gildan 64000)", () => {
    expect(lookupPrintCost(6)).toBe(8.5);
  });

  it("throws UnknownBlueprintError for an unknown blueprint ID", () => {
    expect(() => lookupPrintCost(99999)).toThrow(UnknownBlueprintError);
    expect(() => lookupPrintCost(99999)).toThrow("99999");
  });
});

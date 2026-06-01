import { describe, it, expect } from "vitest";
import { validatePricingFloor, PricingFloorError } from "./pricing.js";
import { defaultEtsyPriceUsd } from "./constants.js";

const PRINT_COST = 10.09;

describe("validatePricingFloor", () => {
  it("passes at exactly 2.5× print cost", () => {
    expect(() => validatePricingFloor(PRINT_COST * 2.5, PRINT_COST)).not.toThrow();
  });

  it("fails just under 2.5×", () => {
    expect(() => validatePricingFloor(PRINT_COST * 2.5 - 0.01, PRINT_COST)).toThrow(
      PricingFloorError
    );
  });

  it("passes just over 2.5×", () => {
    expect(() => validatePricingFloor(PRINT_COST * 2.5 + 0.01, PRINT_COST)).not.toThrow();
  });

  it("canonical $26.99 price passes and yields a healthy margin", () => {
    const price = 26.99;
    const printAndShip = 14.38; // 10.09 print + 4.29 ship
    const transactionFee = price * 0.065;   // 6.5%
    const paymentFee = price * 0.03 + 0.25; // 3% + $0.25
    const listingFee = 0.2;
    const etsyFees = transactionFee + paymentFee + listingFee;
    const margin = price - printAndShip - etsyFees;

    expect(() => validatePricingFloor(price, PRINT_COST)).not.toThrow();
    // margin works out to ~$9.60 once all three fee components are included
    expect(margin).toBeCloseTo(9.60, 1);
  });
});

describe("defaultEtsyPriceUsd", () => {
  it("returns 25.99 for blueprint 145", () => {
    expect(defaultEtsyPriceUsd(145)).toBe(25.99);
  });

  it("bp145 default clears the pricing floor ($10.09 × 2.5 = $25.23)", () => {
    expect(() => validatePricingFloor(defaultEtsyPriceUsd(145), PRINT_COST)).not.toThrow();
  });

  it("returns 0 for an unrecognised blueprint so validatePricingFloor still rejects it", () => {
    const unknownBlueprint = 9999;
    expect(defaultEtsyPriceUsd(unknownBlueprint)).toBe(0);
    expect(() => validatePricingFloor(0, PRINT_COST)).toThrow(PricingFloorError);
  });
});

import { describe, it, expect } from "vitest";
import { validatePricingFloor, PricingFloorError } from "./pricing.js";

const PRINT_COST = 8.5;

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

  it("canonical $24.99 price passes and yields a healthy margin", () => {
    const price = 24.99;
    const printAndShip = 13.0;
    const transactionFee = price * 0.065;   // 6.5%
    const paymentFee = price * 0.03 + 0.25; // 3% + $0.25
    const listingFee = 0.2;
    const etsyFees = transactionFee + paymentFee + listingFee;
    const margin = price - printAndShip - etsyFees;

    expect(() => validatePricingFloor(price, PRINT_COST)).not.toThrow();
    // margin works out to ~$9.17 once all three fee components are included
    expect(margin).toBeCloseTo(9.17, 1);
  });
});

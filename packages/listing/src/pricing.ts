export class PricingFloorError extends Error {
  constructor(priceUsd: number, printCostUsd: number) {
    super(
      `Price $${priceUsd.toFixed(2)} is below the required floor of $${(printCostUsd * 2.5).toFixed(2)} (print cost $${printCostUsd.toFixed(2)} × 2.5)`
    );
    this.name = "PricingFloorError";
  }
}

export function validatePricingFloor(priceUsd: number, printCostUsd: number): void {
  if (priceUsd < printCostUsd * 2.5) {
    throw new PricingFloorError(priceUsd, printCostUsd);
  }
}

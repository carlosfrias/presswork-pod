import {
  BLUEPRINT_PRINT_COST_USD,
  ETSY_FEE_TRANSACTION_PCT,
  ETSY_FEE_PROCESSING_PCT,
  ETSY_FEE_PROCESSING_FIXED_USD,
  ETSY_FEE_LISTING_USD,
} from "./constants.js";

export class UnknownBlueprintError extends Error {
  constructor(blueprintId: number) {
    super(`No print cost configured for blueprint ID ${blueprintId}. Add it to BLUEPRINT_PRINT_COST_USD.`);
    this.name = "UnknownBlueprintError";
  }
}

export function computeEtsyFees(saleUsd: number): number {
  return (
    saleUsd * ETSY_FEE_TRANSACTION_PCT +
    saleUsd * ETSY_FEE_PROCESSING_PCT +
    ETSY_FEE_PROCESSING_FIXED_USD +
    ETSY_FEE_LISTING_USD
  );
}

export function lookupPrintCost(blueprintId: number): number {
  const cost = BLUEPRINT_PRINT_COST_USD[blueprintId];
  if (cost === undefined) {
    throw new UnknownBlueprintError(blueprintId);
  }
  return cost;
}

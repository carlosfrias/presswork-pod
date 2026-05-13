import {
  BLUEPRINT_PRINT_COST_USD,
  ETSY_FEE_TRANSACTION_PCT,
  ETSY_FEE_PROCESSING_PCT,
  ETSY_FEE_PROCESSING_FIXED_USD,
  ETSY_FEE_LISTING_USD,
  USD_RATES,
} from "./constants.js";

export class UnknownBlueprintError extends Error {
  constructor(blueprintId: number) {
    super(`No print cost configured for blueprint ID ${blueprintId}. Add it to BLUEPRINT_PRINT_COST_USD.`);
    this.name = "UnknownBlueprintError";
  }
}

export class UnknownCurrencyError extends Error {
  constructor(code: string) {
    super(`No USD rate configured for currency ${code}. Add it to USD_RATES.`);
    this.name = "UnknownCurrencyError";
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

// Normalize a buyer-paid amount in their currency to USD using the static rate
// table. EUR 24.99 → ~USD 26.99. Etsy reports payouts in USD anyway, so this is
// a reporting approximation — exact economics still come from Etsy's payout API.
export function normalizeToUsd(amount: number, currencyCode: string): number {
  const rate = USD_RATES[currencyCode.toUpperCase()];
  if (rate === undefined) {
    throw new UnknownCurrencyError(currencyCode);
  }
  return amount * rate;
}

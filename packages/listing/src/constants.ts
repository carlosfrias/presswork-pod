export const MAX_ETSY_REQ_PER_SEC = 10;
export const MAX_ETSY_REQ_PER_DAY = 10000;

export const LISTING_DEFAULTS = {
  who_made: "i_did",
  when_made: "made_to_order",
  is_supply: false,
  state: "draft",
} as const;

// Gildan 64000 base print cost in USD (v1 single-product scope)
export const GILDAN_64000_PRINT_COST_USD = 8.5;

// Per-blueprint default variant price (in cents) sent to Printify on create-product.
// Printify requires variants.*.price > 0 even for hidden products. The buyer-facing
// price lives on the Etsy listing; this number is internal Printify metadata only.
// Each blueprint should have a value derived from its print cost so non-tshirt
// blueprints don't get rejected by Printify validation. Add a row when supporting
// a new blueprint. Verify in Printify Dashboard or via a smoke product create.
const PRINTIFY_VARIANT_PRICE_CENTS_BY_BLUEPRINT: Record<number, number> = {
  // Gildan 64000 Softstyle Unisex T-Shirt (matches GILDAN_64000_PRINT_COST_USD * ~3)
  145: 2499,
};

// Fallback used only if a blueprint isn't in the table above. Kept low so a typo
// doesn't accidentally publish a Printify storefront product at $24.99 — Printify
// will still accept it because it's > 0, but the value is clearly placeholder.
export const PRINTIFY_VARIANT_PRICE_FALLBACK_CENTS = 100;

export function printifyVariantPriceCents(blueprintId: number): number {
  return (
    PRINTIFY_VARIANT_PRICE_CENTS_BY_BLUEPRINT[blueprintId] ??
    PRINTIFY_VARIANT_PRICE_FALLBACK_CENTS
  );
}

// Canonical (blueprint_id → print_provider_id) pairing. Printify variant IDs are
// scoped to a (blueprint, provider) pair — sending a mismatched pair returns a
// silent 4xx. Migration 008 backfilled provider=3 only for blueprint 145, so
// any new blueprint added in Design without a row here would write NULL to
// design_packages.printify_print_provider_id. Migration 014's CHECK catches
// that at the DB; this map catches it earlier with an actionable error.
//
// To support a new blueprint: add the entry here AND have Design write the
// matching provider_id when inserting the design row.
const PRINTIFY_BLUEPRINT_PROVIDERS: Record<number, number> = {
  // Gildan 64000 Softstyle Unisex T-Shirt → Marco Fine Arts
  145: 3,
};

// Blueprint metadata (materials, processing-day windows, variation axes,
// per-variant quantity) lives in @presswork/shared/etsy-blueprints so the
// dashboard's payload-preview helper can use the same data without
// importing the listing CLI package. Re-exported here for back-compat.
export {
  BLUEPRINT_MATERIALS,
  BLUEPRINT_PROCESSING_DAYS,
  BLUEPRINT_VARIATION_AXES,
  POD_VARIANT_QUANTITY,
  blueprintMaterials,
  blueprintProcessingDays,
  blueprintVariationAxes,
} from "@presswork/shared";

// Dynamic Mockups per-blueprint template registry lives in @presswork/shared
// so the dashboard's "Generate Dynamic Mockups" server action can use it
// without depending on the listing CLI package. Re-exported here for
// back-compat / locality with other blueprint constants.
export { dynamicMockupsTemplate } from "@presswork/shared";

export function assertBlueprintSupported(
  blueprintId: number,
  printProviderId: number
): void {
  const expected = PRINTIFY_BLUEPRINT_PROVIDERS[blueprintId];
  if (expected === undefined) {
    throw new Error(
      `Unknown Printify blueprint ${blueprintId}. Register the (blueprint, provider) pair in PRINTIFY_BLUEPRINT_PROVIDERS (packages/listing/src/constants.ts) before publishing.`
    );
  }
  if (expected !== printProviderId) {
    throw new Error(
      `Printify (blueprint ${blueprintId}, provider ${printProviderId}) does not match the registered pairing (expected provider ${expected}).`
    );
  }
}

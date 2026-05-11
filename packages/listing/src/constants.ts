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

// Etsy taxonomy ID for Clothing → Unisex Adult Clothing → Tops & Tees → T-shirts
// TODO: verify via GET /application/seller-taxonomy/nodes once Etsy API access is live
export const ETSY_TAXONOMY_ID_TSHIRT = 68887043;

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

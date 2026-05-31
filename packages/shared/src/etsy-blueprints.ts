/**
 * Per-blueprint metadata used to build Etsy POD payloads.
 *
 * Lives in @presswork/shared because both the listing agent (publisher) and
 * the dashboard (Etsy payload preview) need it. The publisher reads it during
 * executeEtsyPublish; the dashboard reads it to render the JSON that would be
 * POSTed when the operator approves a listing.
 *
 * Adding a new blueprint requires entries in all three tables below plus the
 * (blueprint, provider) pairing in packages/listing/src/constants.ts.
 */

// Materials sent on Etsy createDraftListing. Etsy treats materials as
// free-form strings (not enumerated IDs); they appear in listing metadata
// and feed light filtering/search signals. Short and human-readable.
export const BLUEPRINT_MATERIALS: Record<number, string[]> = {
  // Gildan 64000 Softstyle Unisex T-Shirt
  145: ["Cotton"],
};

// Etsy processing-time window in days, mirroring the print provider's
// typical lead time before the order ships. Used as fallback values when
// the readiness state doesn't already encode this — keeps the API payload
// reproducible without an extra Etsy call.
export const BLUEPRINT_PROCESSING_DAYS: Record<number, { min: number; max: number }> = {
  145: { min: 1, max: 3 },
};

// Ordered names of the property axes, positionally matching the order Printify
// returns option values in `variant.options` (see extractVariantOptions in
// packages/listing/src/printify.ts). For Gildan 64000 (145) Printify yields
// [color, size] — e.g. ["white","s"] — so the axes are ["Color","Size"].
// Getting this backwards mislabels the Etsy variation (e.g. "Size: White").
// Confirm with a smoke product create when adding a new blueprint.
export const BLUEPRINT_VARIATION_AXES: Record<number, string[]> = {
  145: ["Color", "Size"],
};

// Quantity Etsy shows for each POD variant. POD blueprints fulfill on
// demand, so a high value avoids "out of stock" while still being a finite
// integer (Etsy rejects null / -1 / "infinite").
export const POD_VARIANT_QUANTITY = 999;

// Etsy property_ids for CUSTOM variations (not predefined taxonomy properties):
// 513 for the first variation axis, 514 for the second. Etsy allows at most two
// custom variations. Each property_value in an inventory PUT must carry one of
// these ids — without it Etsy fails to parse the product and returns a
// misleading `Missing input parameter: [quantity]` 400.
// Ref: developers.etsy.com third-variation tutorial.
export const ETSY_CUSTOM_PROPERTY_IDS = [513, 514] as const;

// Packaged physical specs sent on createDraftListing so Etsy "calculated"
// shipping profiles can compute postage (they reject the listing otherwise:
// "missing item_weight … item_dimensions_unit"). These are the product's real
// shipped dimensions/weight, NOT a shipping price — Etsy + the buyer's location
// determine the rate. Approximate single-unit, poly-mailer values; tune per
// blueprint. Harmless on flat-rate profiles (Etsy just ignores them there).
export interface BlueprintItemSpecs {
  item_weight: number;
  item_weight_unit: "oz" | "lb" | "g" | "kg";
  item_length: number;
  item_width: number;
  item_height: number;
  item_dimensions_unit: "in" | "cm" | "mm" | "m" | "ft" | "yd";
}

export const BLUEPRINT_ITEM_SPECS: Record<number, BlueprintItemSpecs> = {
  // Gildan 64000 unisex tee, folded in a poly mailer.
  145: {
    item_weight: 6,
    item_weight_unit: "oz",
    item_length: 10,
    item_width: 8,
    item_height: 1,
    item_dimensions_unit: "in",
  },
};

export function blueprintItemSpecs(
  blueprintId: number
): BlueprintItemSpecs | undefined {
  return BLUEPRINT_ITEM_SPECS[blueprintId];
}

export function blueprintMaterials(blueprintId: number): string[] | undefined {
  return BLUEPRINT_MATERIALS[blueprintId];
}

export function blueprintProcessingDays(
  blueprintId: number
): { min: number; max: number } | undefined {
  return BLUEPRINT_PROCESSING_DAYS[blueprintId];
}

export function blueprintVariationAxes(blueprintId: number): string[] | undefined {
  return BLUEPRINT_VARIATION_AXES[blueprintId];
}

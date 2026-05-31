import {
  blueprintVariationAxes,
  ETSY_CUSTOM_PROPERTY_IDS,
  POD_VARIANT_QUANTITY,
} from "./etsy-blueprints.js";
import type { EtsyInventoryInput, EtsyInventoryProduct } from "./etsy-api.js";

export class InventoryMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryMappingError";
  }
}

interface PrintifyVariantRow {
  id: number;
  values: string[];
}

interface BuildInventoryArgs {
  design: {
    printify_blueprint_id?: number | null;
    printify_variants?: PrintifyVariantRow[] | null;
  };
  priceUsd: number;
  // Etsy readiness_state_id (Processing Profiles). Required by Etsy on every
  // offering for physical listings; the publish path always passes it. Nullable
  // so the dashboard preview can build a payload without env config.
  readinessStateId?: number | null;
}

// Title-case a value coming back from Printify (lowercased by extractVariantOptions).
// "s" → "S", "black" → "Black", "2xl" → "2XL" (numeric-leading tokens uppercase whole).
function titleCaseValue(value: string): string {
  if (!value) return value;
  if (/^\d/.test(value)) {
    return value.toUpperCase();
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Build an Etsy inventory PUT payload from a design package's printify_variants.
 *
 * Uses Etsy's custom-property path (property_name + values) so we don't need
 * to look up numeric Etsy property IDs per taxonomy. Each Printify variant
 * becomes one Etsy `product` with one offering at the listing price.
 *
 * Pure function — no IO, no side effects. Both the listing publisher (live
 * publish path) and the dashboard preview helper call it with the same
 * inputs and get the same output.
 */
export function buildInventoryFromDesign({
  design,
  priceUsd,
  readinessStateId,
}: BuildInventoryArgs): EtsyInventoryInput {
  if (!design.printify_blueprint_id) {
    throw new InventoryMappingError(
      "design has no printify_blueprint_id — cannot resolve variation axes"
    );
  }

  const variants = design.printify_variants ?? [];
  if (variants.length === 0) {
    throw new InventoryMappingError(
      "design has no printify_variants — Printify product creation must run first"
    );
  }

  const axes = blueprintVariationAxes(design.printify_blueprint_id);
  if (!axes || axes.length === 0) {
    throw new InventoryMappingError(
      `no BLUEPRINT_VARIATION_AXES entry for blueprint ${design.printify_blueprint_id}`
    );
  }

  // Etsy custom variations are limited to two axes (property_ids 513 and 514).
  if (axes.length > ETSY_CUSTOM_PROPERTY_IDS.length) {
    throw new InventoryMappingError(
      `blueprint ${design.printify_blueprint_id} has ${axes.length} variation axes but Etsy custom variations support at most ${ETSY_CUSTOM_PROPERTY_IDS.length}`
    );
  }

  if (priceUsd <= 0) {
    throw new InventoryMappingError(`priceUsd must be positive (got ${priceUsd})`);
  }

  const products: EtsyInventoryProduct[] = variants.map((variant) => {
    if (variant.values.length !== axes.length) {
      throw new InventoryMappingError(
        `printify variant ${variant.id} has ${variant.values.length} values but blueprint ${design.printify_blueprint_id} expects ${axes.length} axes (${axes.join(", ")})`
      );
    }
    const property_values = axes.map((axisName, idx) => ({
      // 513 for the first axis, 514 for the second — required by Etsy even for
      // custom variations (see ETSY_CUSTOM_PROPERTY_IDS).
      property_id: ETSY_CUSTOM_PROPERTY_IDS[idx]!,
      property_name: axisName,
      // Empty for custom variations; Etsy assigns the internal value id.
      value_ids: [],
      values: [titleCaseValue(variant.values[idx]!)],
    }));
    return {
      sku: String(variant.id),
      property_values,
      offerings: [
        {
          price: priceUsd,
          quantity: POD_VARIANT_QUANTITY,
          is_enabled: true,
          // Only include when known. Etsy requires it on physical listings; the
          // publish path always supplies it. (null/undefined → omit, e.g. preview.)
          ...(typeof readinessStateId === "number" && readinessStateId > 0
            ? { readiness_state_id: readinessStateId }
            : {}),
        },
      ],
    };
  });

  // Price and quantity are uniform across variants (empty arrays). SKU is the
  // Printify variant id — unique per variant — so it varies on every axis;
  // list those property_ids or Etsy rejects with "sku must be consistent
  // across all products".
  const variationPropertyIds = axes.map((_, idx) => ETSY_CUSTOM_PROPERTY_IDS[idx]!);

  return {
    products,
    price_on_property: [],
    quantity_on_property: [],
    sku_on_property: variationPropertyIds,
    readiness_state_on_property: [],
  };
}

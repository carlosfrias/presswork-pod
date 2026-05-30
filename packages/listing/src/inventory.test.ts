import { describe, it, expect } from "vitest";
import { buildInventoryFromDesign, InventoryMappingError } from "./inventory.js";
import { POD_VARIANT_QUANTITY, EtsyInventoryInputSchema } from "@presswork/shared";

// Printify returns variant option values in [color, size] order for blueprint
// 145 (matches real data: ["white","s"]). Fixtures mirror that order.
const baseDesign = {
  printify_blueprint_id: 145,
  printify_variants: [
    { id: 38163, values: ["black", "s"] },
    { id: 38177, values: ["black", "m"] },
    { id: 38191, values: ["black", "l"] },
  ],
};

describe("buildInventoryFromDesign", () => {
  it("maps each printify variant to one Etsy product with color + size", () => {
    const inv = buildInventoryFromDesign({
      design: baseDesign,
      priceUsd: 24.99,
      readinessStateId: 12345,
    });
    expect(inv.products).toHaveLength(3);
    expect(inv.products[0]).toEqual({
      sku: "38163",
      property_values: [
        // Etsy custom-variation slots 513/514 are mandatory; without them Etsy
        // returns "Missing input parameter: [quantity]". Axis order matches
        // Printify's [color, size] value order.
        { property_id: 513, property_name: "Color", value_ids: [], values: ["Black"] },
        { property_id: 514, property_name: "Size", value_ids: [], values: ["S"] },
      ],
      offerings: [
        { price: 24.99, quantity: 999, is_enabled: true, readiness_state_id: 12345 },
      ],
    });
    expect(inv.readiness_state_on_property).toEqual([]);
  });

  it("assigns Etsy custom-variation property_ids 513/514 in axis order", () => {
    const inv = buildInventoryFromDesign({ design: baseDesign, priceUsd: 24.99 });
    for (const product of inv.products) {
      expect(product.property_values.map((pv) => pv.property_id)).toEqual([513, 514]);
      for (const pv of product.property_values) {
        expect(pv.value_ids).toEqual([]);
      }
    }
  });

  it("puts readiness_state_id on every offering when provided, omits it otherwise", () => {
    const withId = buildInventoryFromDesign({
      design: baseDesign,
      priceUsd: 24.99,
      readinessStateId: 777,
    });
    for (const product of withId.products) {
      for (const offering of product.offerings) {
        expect(offering.readiness_state_id).toBe(777);
      }
    }

    // Preview path (no env) must still build a valid payload, just without the id.
    const withoutId = buildInventoryFromDesign({ design: baseDesign, priceUsd: 24.99 });
    expect(withoutId.products[0]!.offerings[0]).not.toHaveProperty("readiness_state_id");
  });

  it("title-cases plain size labels and uppercases numeric ones", () => {
    const inv = buildInventoryFromDesign({
      design: {
        printify_blueprint_id: 145,
        // [color, size] order; size is the second axis.
        printify_variants: [
          { id: 1, values: ["navy", "xl"] },
          { id: 2, values: ["navy", "2xl"] },
          { id: 3, values: ["navy", "3xl"] },
        ],
      },
      priceUsd: 24.99,
    });
    expect(inv.products.map((p) => p.property_values[1]!.values[0])).toEqual([
      "Xl",
      "2XL",
      "3XL",
    ]);
  });

  it("emits empty price_on_property arrays so all variants share the listing price", () => {
    const inv = buildInventoryFromDesign({ design: baseDesign, priceUsd: 24.99 });
    expect(inv.price_on_property).toEqual([]);
    expect(inv.quantity_on_property).toEqual([]);
    expect(inv.sku_on_property).toEqual([]);
  });

  it("rejects a design with no blueprint", () => {
    expect(() =>
      buildInventoryFromDesign({
        design: { printify_blueprint_id: null, printify_variants: baseDesign.printify_variants },
        priceUsd: 24.99,
      })
    ).toThrow(InventoryMappingError);
  });

  it("rejects a design with no variants", () => {
    expect(() =>
      buildInventoryFromDesign({
        design: { printify_blueprint_id: 145, printify_variants: [] },
        priceUsd: 24.99,
      })
    ).toThrow(/no printify_variants/);
  });

  it("rejects a blueprint missing from BLUEPRINT_VARIATION_AXES", () => {
    expect(() =>
      buildInventoryFromDesign({
        design: { printify_blueprint_id: 9999, printify_variants: baseDesign.printify_variants },
        priceUsd: 24.99,
      })
    ).toThrow(/BLUEPRINT_VARIATION_AXES/);
  });

  it("rejects a non-positive price", () => {
    expect(() =>
      buildInventoryFromDesign({ design: baseDesign, priceUsd: 0 })
    ).toThrow(/priceUsd must be positive/);
  });

  it("rejects a variant whose values count doesn't match the axes", () => {
    expect(() =>
      buildInventoryFromDesign({
        design: {
          printify_blueprint_id: 145,
          printify_variants: [{ id: 38163, values: ["s"] }],
        },
        priceUsd: 24.99,
      })
    ).toThrow(/expects 2 axes/);
  });

  it("regression: every offering quantity equals POD_VARIANT_QUANTITY (999) — Etsy returns 400 when quantity is missing", () => {
    // Guard against any future regression that drops the quantity field from
    // offerings. The MSW handler in publisher-flow.test.ts mirrors Etsy's
    // real 400 response for missing/zero quantity, so this unit-level check
    // catches the same regression without needing the integration flag.
    const inv = buildInventoryFromDesign({ design: baseDesign, priceUsd: 24.99 });

    // Every offering must carry exactly POD_VARIANT_QUANTITY = 999.
    for (const product of inv.products) {
      for (const offering of product.offerings) {
        expect(offering.quantity).toBe(POD_VARIANT_QUANTITY);
        expect(offering.quantity).toBe(999);
      }
    }

    // The full shape must satisfy the Etsy inventory schema without throwing.
    expect(() => EtsyInventoryInputSchema.parse(inv)).not.toThrow();
  });
});

import { describe, it, expect } from "vitest";
import { buildInventoryFromDesign, InventoryMappingError } from "./inventory.js";
import { POD_VARIANT_QUANTITY, EtsyInventoryInputSchema } from "@presswork/shared";

const baseDesign = {
  printify_blueprint_id: 145,
  printify_variants: [
    { id: 38163, values: ["s", "black"] },
    { id: 38177, values: ["m", "black"] },
    { id: 38191, values: ["l", "black"] },
  ],
};

describe("buildInventoryFromDesign", () => {
  it("maps each printify variant to one Etsy product with size + color", () => {
    const inv = buildInventoryFromDesign({ design: baseDesign, priceUsd: 24.99 });
    expect(inv.products).toHaveLength(3);
    expect(inv.products[0]).toEqual({
      sku: "38163",
      property_values: [
        // Etsy custom-variation slots 513/514 are mandatory; without them Etsy
        // returns "Missing input parameter: [quantity]".
        { property_id: 513, property_name: "Size", value_ids: [], values: ["S"] },
        { property_id: 514, property_name: "Color", value_ids: [], values: ["Black"] },
      ],
      offerings: [{ price: 24.99, quantity: 999, is_enabled: true }],
    });
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

  it("title-cases plain size labels and uppercases numeric ones", () => {
    const inv = buildInventoryFromDesign({
      design: {
        printify_blueprint_id: 145,
        printify_variants: [
          { id: 1, values: ["xl", "navy"] },
          { id: 2, values: ["2xl", "navy"] },
          { id: 3, values: ["3xl", "navy"] },
        ],
      },
      priceUsd: 24.99,
    });
    expect(inv.products.map((p) => p.property_values[0]!.values[0])).toEqual([
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

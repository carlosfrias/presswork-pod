import { describe, it, expect } from "vitest";
import { buildInventoryFromDesign, InventoryMappingError } from "./inventory.js";

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
        { property_name: "Size", values: ["S"] },
        { property_name: "Color", values: ["Black"] },
      ],
      offerings: [{ price: 24.99, quantity: 999, is_enabled: true }],
    });
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
});

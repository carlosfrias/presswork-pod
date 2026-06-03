import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSupabaseMock, type SupabaseMockOpts } from "@/tests/helpers/supabase-mock";

async function loadModule(opts: SupabaseMockOpts) {
  const { client, capture } = makeSupabaseMock(opts);
  vi.doMock("@/lib/supabase/server", () => ({ serviceClient: () => client }));
  vi.resetModules();
  const mod = await import("./variants");
  return { mod, capture };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

const CATALOG_ROWS = [
  { variant_id: 38191, color: "White", size: "L" },
  { variant_id: 38163, color: "White", size: "S" },
  { variant_id: 38177, color: "White", size: "M" },
  { variant_id: 40000, color: "Black", size: "M" },
  { variant_id: 39999, color: "Black", size: "S" },
];

describe("getCatalogVariants", () => {
  it("maps variant_id->id and sorts by color then garment size order", async () => {
    const { mod } = await loadModule({
      printify_variant_catalog: { rows: CATALOG_ROWS },
    });

    const variants = await mod.getCatalogVariants(145, 39);

    // Black before White (alphabetical); within color, S before M before L.
    expect(variants).toEqual([
      { id: 39999, color: "Black", size: "S" },
      { id: 40000, color: "Black", size: "M" },
      { id: 38163, color: "White", size: "S" },
      { id: 38177, color: "White", size: "M" },
      { id: 38191, color: "White", size: "L" },
    ]);
  });

  it("queries the catalog filtered by blueprint, provider, and availability", async () => {
    const { mod, capture } = await loadModule({
      printify_variant_catalog: { rows: CATALOG_ROWS },
    });

    await mod.getCatalogVariants(145, 39);

    expect(capture.selects[0]).toEqual({
      table: "printify_variant_catalog",
      cols: "variant_id, color, size",
    });
  });

  it("drops rows missing color or size", async () => {
    const { mod } = await loadModule({
      printify_variant_catalog: {
        rows: [
          { variant_id: 1, color: "White", size: "S" },
          { variant_id: 2, color: null, size: "M" },
          { variant_id: 3, color: "Black", size: null },
        ],
      },
    });

    const variants = await mod.getCatalogVariants(145, 39);
    expect(variants).toEqual([{ id: 1, color: "White", size: "S" }]);
  });

  it("throws when the query errors", async () => {
    const { mod } = await loadModule({
      printify_variant_catalog: { selectError: { message: "boom" } },
    });

    await expect(mod.getCatalogVariants(145, 39)).rejects.toThrow(/boom/);
  });
});

describe("getCatalogVariantIds", () => {
  it("returns just the ids in the same sorted order", async () => {
    const { mod } = await loadModule({
      printify_variant_catalog: { rows: CATALOG_ROWS },
    });

    const ids = await mod.getCatalogVariantIds(145, 39);
    expect(ids).toEqual([39999, 40000, 38163, 38177, 38191]);
  });
});

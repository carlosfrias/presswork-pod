import "server-only";
import { serviceClient } from "@/lib/supabase/server";

/**
 * Garment-order for sizes. Unknown sizes (not in this list) are sorted
 * alphabetically after the known sizes.
 */
const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"];

function compareSizes(a: string, b: string): number {
  const ai = SIZE_ORDER.indexOf(a);
  const bi = SIZE_ORDER.indexOf(b);
  // Both known — sort by position
  if (ai !== -1 && bi !== -1) return ai - bi;
  // Only a is known — it comes first
  if (ai !== -1) return -1;
  // Only b is known — it comes first
  if (bi !== -1) return 1;
  // Both unknown — alphabetical
  return a.localeCompare(b);
}

function sortSizes(sizes: string[]): string[] {
  return [...sizes].sort(compareSizes);
}

/**
 * Returns distinct, available colors and sizes from printify_variant_catalog
 * for the given blueprint + print provider.
 *
 * Colors are sorted alphabetically; sizes are sorted in garment order
 * (XS, S, M, L, XL, 2XL, 3XL, 4XL, 5XL) with unknown sizes last.
 *
 * Throws if the Supabase query fails.
 */
export async function getVariantOptions(
  blueprintId: number,
  printProviderId: number
): Promise<{ colors: string[]; sizes: string[] }> {
  const db = serviceClient();
  const { data, error } = await db
    .from("printify_variant_catalog")
    .select("color, size")
    .eq("blueprint_id", blueprintId)
    .eq("print_provider_id", printProviderId)
    .eq("is_available", true);

  if (error) {
    throw new Error(
      `getVariantOptions failed for blueprint ${blueprintId} / provider ${printProviderId}: ${error.message}`
    );
  }

  const colorSet = new Set<string>();
  const sizeSet = new Set<string>();

  for (const row of (data ?? []) as { color: string | null; size: string | null }[]) {
    if (row.color) colorSet.add(row.color);
    if (row.size) sizeSet.add(row.size);
  }

  const colors = [...colorSet].sort((a, b) => a.localeCompare(b));
  const sizes = sortSizes([...sizeSet]);

  return { colors, sizes };
}

/** A single catalog row: a Printify variant id and its color/size labels. */
export interface CatalogVariant {
  id: number;
  color: string;
  size: string;
}

/**
 * Returns every available variant (id + color + size) from
 * printify_variant_catalog for the given blueprint + print provider.
 *
 * This is the full universe an operator can offer on a listing — the listing
 * variant override is validated against (and built from) this set, so the
 * operator can ADD catalog colors the design package didn't ship with, not
 * just narrow the design's set.
 *
 * Sizes within a color are returned in garment order; colors are alphabetical.
 * Throws if the Supabase query fails.
 */
export async function getCatalogVariants(
  blueprintId: number,
  printProviderId: number
): Promise<CatalogVariant[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("printify_variant_catalog")
    .select("variant_id, color, size")
    .eq("blueprint_id", blueprintId)
    .eq("print_provider_id", printProviderId)
    .eq("is_available", true);

  if (error) {
    throw new Error(
      `getCatalogVariants failed for blueprint ${blueprintId} / provider ${printProviderId}: ${error.message}`
    );
  }

  const rows = (data ?? []) as {
    variant_id: number;
    color: string | null;
    size: string | null;
  }[];

  return rows
    .filter((r) => r.color && r.size)
    .map((r) => ({ id: r.variant_id, color: r.color as string, size: r.size as string }))
    .sort((a, b) => a.color.localeCompare(b.color) || compareSizes(a.size, b.size));
}

/**
 * The set of variant ids the catalog offers for a blueprint + provider.
 * Used as the validation universe for the per-listing override.
 */
export async function getCatalogVariantIds(
  blueprintId: number,
  printProviderId: number
): Promise<number[]> {
  const variants = await getCatalogVariants(blueprintId, printProviderId);
  return variants.map((v) => v.id);
}

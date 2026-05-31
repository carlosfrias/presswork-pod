import "server-only";
import { serviceClient } from "@/lib/supabase/server";

/**
 * Garment-order for sizes. Unknown sizes (not in this list) are sorted
 * alphabetically after the known sizes.
 */
const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"];

function sortSizes(sizes: string[]): string[] {
  return [...sizes].sort((a, b) => {
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
  });
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

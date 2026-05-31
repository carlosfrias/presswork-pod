/**
 * Guards for per-listing variant-ID overrides.
 *
 * The Listing Agent allows an operator to pin a listing to a subset of the
 * variant IDs that the design package carries (e.g. "only S/M/L in black").
 * This module validates that any such override is actually a subset of the
 * design's available IDs — catching fat-finger mismatches before they reach
 * the Printify API.
 */

export class VariantSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VariantSelectionError";
  }
}

/**
 * Asserts that every id in `selectedIds` is present in `availableIds`.
 *
 * - Empty `selectedIds` is a no-op: callers treat null-or-empty as "inherit
 *   all variants from the design package", so there is nothing to validate.
 * - Throws `VariantSelectionError` naming the offending ids if any selected
 *   id falls outside the available set.
 * - Pure function — no IO, no side-effects.
 */
export function validateVariantIds(
  selectedIds: number[],
  availableIds: number[]
): void {
  if (selectedIds.length === 0) return;

  const available = new Set<number>(availableIds);
  const bad = selectedIds.filter((id) => !available.has(id));

  if (bad.length > 0) {
    throw new VariantSelectionError(
      `Variant ID(s) not present in the design package's available set: ${bad.join(", ")}`
    );
  }
}

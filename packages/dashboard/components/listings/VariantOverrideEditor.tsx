"use client";

import { useMemo, useState } from "react";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { VariantPicker } from "@/components/variants/VariantPicker";
import { updateListingVariants } from "@/lib/actions/listings";
import type { CatalogVariant } from "@/lib/queries/variants";

const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"];

function sortSizes(sizes: string[]): string[] {
  return [...sizes].sort((a, b) => {
    const ai = SIZE_ORDER.indexOf(a);
    const bi = SIZE_ORDER.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });
}

function sameIdSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((id) => sb.has(id));
}

interface VariantOverrideEditorProps {
  listingId: string;
  /** Full catalog universe (id + color + size) for the design's blueprint/provider. */
  catalogVariants: CatalogVariant[];
  /** Variant ids the design package shipped with — the inherit/default set. */
  designVariantIds: number[];
  /** Current override (NULL = inherit the design set). */
  selectedVariantIds: number[] | null;
}

/**
 * Per-listing color/size editor for an unpublished listing. Works in the same
 * colors × sizes space as the Design review page's VariantPicker, but resolves
 * the selection to Printify variant ids from the catalog and stores it as the
 * listing's `selected_variant_ids` override.
 *
 * Unlike the old narrow-only editor, the universe is the FULL catalog — the
 * operator can ADD colors the design package never shipped with. Any change
 * only takes effect after the Printify product is recreated (Recreate button),
 * which rebuilds mockups + Etsy inventory to match the new set.
 *
 * NULL override = inherit the design set. Submitting an empty selection clears
 * the override back to inherit.
 */
export function VariantOverrideEditor({
  listingId,
  catalogVariants,
  designVariantIds,
  selectedVariantIds,
}: VariantOverrideEditorProps) {
  // Catalog lookups: (color|size) → id, and id → {color,size}.
  const { colorOptions, sizeOptions, keyToId, idToCs } = useMemo(() => {
    const keyToId = new Map<string, number>();
    const idToCs = new Map<number, { color: string; size: string }>();
    const colors = new Set<string>();
    const sizes = new Set<string>();
    for (const v of catalogVariants) {
      keyToId.set(`${v.color}|${v.size}`, v.id);
      idToCs.set(v.id, { color: v.color, size: v.size });
      colors.add(v.color);
      sizes.add(v.size);
    }
    return {
      colorOptions: [...colors].sort((a, b) => a.localeCompare(b)),
      sizeOptions: sortSizes([...sizes]),
      keyToId,
      idToCs,
    };
  }, [catalogVariants]);

  // The currently-offered ids: explicit override, else the inherited design set.
  const initialOfferedIds = selectedVariantIds ?? designVariantIds;

  // Seed the color/size selection from whatever ids are offered today.
  const seed = useMemo(() => {
    const colors = new Set<string>();
    const sizes = new Set<string>();
    for (const id of initialOfferedIds) {
      const cs = idToCs.get(id);
      if (cs) {
        colors.add(cs.color);
        sizes.add(cs.size);
      }
    }
    return {
      colors: [...colors].sort((a, b) => a.localeCompare(b)),
      sizes: sortSizes([...sizes]),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idToCs, selectedVariantIds]);

  const [selectedColors, setSelectedColors] = useState<string[]>(seed.colors);
  const [selectedSizes, setSelectedSizes] = useState<string[]>(seed.sizes);

  // Resolve the colors × sizes cross-product to the catalog ids that exist.
  const resolvedIds = useMemo(() => {
    const ids: number[] = [];
    for (const color of selectedColors) {
      for (const size of selectedSizes) {
        const id = keyToId.get(`${color}|${size}`);
        if (id !== undefined) ids.push(id);
      }
    }
    return ids;
  }, [selectedColors, selectedSizes, keyToId]);

  // Compare what would actually be offered. An empty resolution means "inherit",
  // so it equals the design set for the purpose of detecting a real change.
  const effectiveInitial = initialOfferedIds;
  const effectiveResolved = resolvedIds.length > 0 ? resolvedIds : designVariantIds;
  const dirty = !sameIdSet(effectiveInitial, effectiveResolved);

  function resetToCurrent() {
    setSelectedColors(seed.colors);
    setSelectedSizes(seed.sizes);
  }

  function resetToDesignDefault() {
    const colors = new Set<string>();
    const sizes = new Set<string>();
    for (const id of designVariantIds) {
      const cs = idToCs.get(id);
      if (cs) {
        colors.add(cs.color);
        sizes.add(cs.size);
      }
    }
    setSelectedColors([...colors].sort((a, b) => a.localeCompare(b)));
    setSelectedSizes(sortSizes([...sizes]));
  }

  if (catalogVariants.length === 0) {
    return (
      <p className="text-xs text-(--text-faint)">
        No catalog variants for this blueprint/provider — seed the catalog first.
      </p>
    );
  }

  return (
    <form action={updateListingVariants} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={listingId} />

      <p className="text-xs text-(--text-muted) leading-relaxed rounded-(--radius-sm) border border-(--accent-warm)/30 bg-(--accent-warm)/5 px-3 py-2">
        Adding or changing colors here only takes effect after you Recreate the
        Printify product, which rebuilds mockups and Etsy inventory to match.
      </p>

      <VariantPicker
        colorOptions={colorOptions}
        sizeOptions={sizeOptions}
        selectedColors={selectedColors}
        selectedSizes={selectedSizes}
        onColorsChange={setSelectedColors}
        onSizesChange={setSelectedSizes}
      />

      <p className="text-xs text-(--text-faint)">
        {resolvedIds.length > 0
          ? `${selectedColors.length} color${selectedColors.length === 1 ? "" : "s"} × ${selectedSizes.length} size${selectedSizes.length === 1 ? "" : "s"} → ${resolvedIds.length} variant${resolvedIds.length === 1 ? "" : "s"}`
          : "No colors/sizes selected — saving will clear the override (inherit the design set)."}
      </p>

      {/* Resolved ids submitted as repeated hidden inputs. */}
      {resolvedIds.map((id) => (
        <input key={id} type="hidden" name="selectedVariantIds" value={id} />
      ))}

      <div className="flex items-center gap-3">
        <SubmitButton
          variant="secondary"
          size="sm"
          idleLabel="Save variant selection"
          pendingLabel="Saving…"
          disabled={!dirty}
        />
        {dirty ? (
          <button
            type="button"
            onClick={resetToCurrent}
            className="text-xs text-(--text-muted) hover:text-(--text-primary)"
          >
            Reset
          </button>
        ) : (
          <span className="text-xs text-(--text-faint)">No unsaved changes</span>
        )}
        <span className="text-(--text-faint) text-xs">·</span>
        <button
          type="button"
          onClick={resetToDesignDefault}
          className="text-xs text-(--text-muted) hover:text-(--accent-warm)"
        >
          Design default
        </button>
      </div>
    </form>
  );
}

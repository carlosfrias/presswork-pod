"use client";

import { useState } from "react";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { updateListingVariants } from "@/lib/actions/listings";

// Inline helper — mirrors the private titleCaseValue in etsy-inventory.ts.
// NOT exported; callers inside this module only.
function titleCaseValue(value: string): string {
  if (!value) return value;
  if (/^\d/.test(value)) return value.toUpperCase();
  return value.charAt(0).toUpperCase() + value.slice(1);
}

interface PrintifyVariant {
  id: number;
  values: string[];
}

interface VariantOverrideEditorProps {
  listingId: string;
  availableVariantIds: number[];
  printifyVariants: PrintifyVariant[] | null;
  selectedVariantIds: number[] | null;
}

/**
 * Per-listing variant selection editor. Lets the operator narrow which
 * Printify variant IDs are offered on this listing (e.g. only S/M/L in black).
 *
 * NULL selection = inherit the full design package set (no override).
 * Non-empty selection = exact subset to use when the Printify product is
 * (re)created. Narrowing colours requires a Printify product recreate so
 * mockups match — there's a note in the UI.
 */
export function VariantOverrideEditor({
  listingId,
  availableVariantIds,
  printifyVariants,
  selectedVariantIds,
}: VariantOverrideEditorProps) {
  // NULL selection means "all checked" — inherit the full set.
  const initialChecked = new Set<number>(
    selectedVariantIds ?? availableVariantIds
  );
  const [checked, setChecked] = useState<Set<number>>(initialChecked);

  const allChecked = availableVariantIds.every((id) => checked.has(id));
  const noneChecked = availableVariantIds.every((id) => !checked.has(id));

  // Dirty: differs from initial selection.
  const initialIsNull = selectedVariantIds === null;
  const currentIsAll = availableVariantIds.every((id) => checked.has(id));
  const dirty = initialIsNull
    ? !currentIsAll
    : !(
        selectedVariantIds!.length === checked.size &&
        selectedVariantIds!.every((id) => checked.has(id))
      );

  function toggle(id: number) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function selectAll() {
    setChecked(new Set(availableVariantIds));
  }

  function deselectAll() {
    setChecked(new Set());
  }

  function reset() {
    setChecked(new Set(selectedVariantIds ?? availableVariantIds));
  }

  function labelFor(id: number): string {
    if (!printifyVariants) return String(id);
    const variant = printifyVariants.find((v) => v.id === id);
    if (!variant) return String(id);
    return variant.values.map(titleCaseValue).join(" / ");
  }

  if (availableVariantIds.length === 0) {
    return (
      <p className="text-xs text-(--text-faint)">
        No variant IDs on design package — create the Printify product first.
      </p>
    );
  }

  return (
    <form action={updateListingVariants} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={listingId} />

      <p className="text-xs text-(--text-muted) leading-relaxed rounded-(--radius-sm) border border-(--accent-warm)/30 bg-(--accent-warm)/5 px-3 py-2">
        Narrowing colors here requires re-creating the Printify product (use
        Recreate) so mockups match.
      </p>

      {/* Select all / deselect all toggle */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={selectAll}
          disabled={allChecked}
          className="text-xs text-(--accent-warm) hover:underline disabled:opacity-40 disabled:no-underline"
        >
          Select all
        </button>
        <span className="text-(--text-faint) text-xs">·</span>
        <button
          type="button"
          onClick={deselectAll}
          disabled={noneChecked}
          className="text-xs text-(--text-muted) hover:text-(--text-primary) disabled:opacity-40"
        >
          Deselect all
        </button>
      </div>

      {/* Variant checkboxes — only checked ids are sent as repeated hidden inputs */}
      <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto pr-1">
        {availableVariantIds.map((id) => (
          <label
            key={id}
            className="flex items-center gap-2 cursor-pointer group"
          >
            <input
              type="checkbox"
              checked={checked.has(id)}
              onChange={() => toggle(id)}
              className="accent-(--accent-warm)"
              aria-label={labelFor(id)}
            />
            <span className="text-sm text-(--text-secondary) group-hover:text-(--text-primary)">
              {labelFor(id)}
            </span>
          </label>
        ))}
      </div>

      {/* Submit checked IDs as repeated hidden inputs — same pattern as selectedImageUrls */}
      {availableVariantIds
        .filter((id) => checked.has(id))
        .map((id) => (
          <input
            key={id}
            type="hidden"
            name="selectedVariantIds"
            value={id}
          />
        ))}

      <div className="flex items-center gap-2">
        <SubmitButton
          variant="secondary"
          size="sm"
          idleLabel="Save variant selection"
          pendingLabel="Saving…"
          disabled={!dirty || noneChecked}
        />
        {dirty && (
          <button
            type="button"
            onClick={reset}
            className="text-xs text-(--text-muted) hover:text-(--text-primary)"
          >
            Reset
          </button>
        )}
        {!dirty && (
          <span className="text-xs text-(--text-faint)">No unsaved changes</span>
        )}
      </div>
    </form>
  );
}

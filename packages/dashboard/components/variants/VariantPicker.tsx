"use client";

import { ColorSwatchSelect } from "./ColorSwatchSelect";

/**
 * Picks shirt colors and sizes to include in the Printify product for this
 * brief, then persists them on regen.
 *
 * Colors use a compact swatch popover (ColorSwatchSelect) — collapsed to a
 * single trigger row so the 60+ Gildan colors don't dominate the card; opens
 * into a searchable swatch grid. Sizes stay as MULTI-select chips: clicking a
 * selected chip removes it, clicking an unselected one adds it. Each chip
 * carries aria-pressed so keyboard / screen-reader users know the state.
 *
 * No "at least one" enforcement here — empty means "let the agent fall back
 * to its defaults". The parent can add a hint if desired.
 *
 * Size display order follows standard garment conventions: XS → S → M → L →
 * XL → 2XL → 3XL → 4XL. Unknown sizes fall to the end.
 */

const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"];

function sortSizes(sizes: string[]): string[] {
  return [...sizes].sort((a, b) => {
    const ai = SIZE_ORDER.indexOf(a);
    const bi = SIZE_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

interface Props {
  colorOptions: string[];
  sizeOptions: string[];
  selectedColors: string[];
  selectedSizes: string[];
  onColorsChange: (c: string[]) => void;
  onSizesChange: (s: string[]) => void;
  disabled?: boolean;
}

export function VariantPicker({
  colorOptions,
  sizeOptions,
  selectedColors,
  selectedSizes,
  onColorsChange,
  onSizesChange,
  disabled = false,
}: Props) {
  function toggleSize(size: string) {
    if (selectedSizes.includes(size)) {
      onSizesChange(selectedSizes.filter((s) => s !== size));
    } else {
      onSizesChange([...selectedSizes, size]);
    }
  }

  const sortedSizeOptions = sortSizes(sizeOptions);

  return (
    <div className="flex flex-col gap-3">
      <ColorSwatchSelect
        options={colorOptions}
        selected={selectedColors}
        onChange={onColorsChange}
        disabled={disabled}
      />
      <div className="flex flex-col gap-1.5">
        <span className="text-xs uppercase tracking-wider text-(--text-muted)">
          Shirt sizes
        </span>
        <div className="flex flex-wrap gap-1.5">
          {sortedSizeOptions.map((size) => (
            <Chip
              key={size}
              active={selectedSizes.includes(size)}
              disabled={disabled}
              onClick={() => toggleSize(size)}
              title={size}
            >
              {size}
            </Chip>
          ))}
        </div>
      </div>
    </div>
  );
}

interface ChipProps {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}

function Chip({ active, disabled, onClick, title, children }: ChipProps) {
  const base =
    "rounded-(--radius-sm) border px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50";
  const variant = active
    ? "border-(--accent-warm) bg-(--accent-warm)/15 text-(--text-primary)"
    : "border-(--surface-line) bg-(--surface-2) text-(--text-secondary) hover:border-(--accent-warm)/60 hover:text-(--text-primary)";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      className={`${base} ${variant}`}
    >
      {children}
    </button>
  );
}

"use client";

/**
 * Multi-select chip rows for picking shirt colors and sizes to include in the
 * Printify product for this brief. Modeled on BgRemovalPicker — same Chip
 * sub-component, same token classes, same operator mental model: pick options,
 * persist on regen.
 *
 * Chips are MULTI-select: clicking a selected chip removes it from the set;
 * clicking an unselected chip adds it. Each chip carries aria-pressed so
 * keyboard / screen-reader users know the current state.
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
  function toggleColor(color: string) {
    if (selectedColors.includes(color)) {
      onColorsChange(selectedColors.filter((c) => c !== color));
    } else {
      onColorsChange([...selectedColors, color]);
    }
  }

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
      <div className="flex flex-col gap-1.5">
        <span className="text-xs uppercase tracking-wider text-(--text-muted)">
          Shirt colors
        </span>
        <div className="flex flex-wrap gap-1.5">
          {colorOptions.map((color) => (
            <Chip
              key={color}
              active={selectedColors.includes(color)}
              disabled={disabled}
              onClick={() => toggleColor(color)}
              title={color}
            >
              {color}
            </Chip>
          ))}
        </div>
      </div>
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

"use client";

import { useState, useTransition } from "react";
import { generatePalette } from "@/lib/actions/palette";
import { isValidHex, normalizeHex, PALETTE_SIZE } from "@/lib/palette";
import { cn } from "@/lib/cn";

/**
 * Five-slot color picker. Each slot has a hex input and a swatch underneath.
 * "Generate" pulls a fresh ML-curated palette (Colormind with local fallback);
 * keep clicking to cycle until a palette lands.
 *
 * The component is fully controlled by the parent — pass `value` (an array of
 * up to 5 hex strings, may be empty / sparse) and `onChange` (called with the
 * new array). The parent decides whether to put this inside a form (then the
 * `name` prop emits a hidden input with the array JSON-encoded) or just hold
 * the value in component state for an out-of-band action.
 */
interface ColorPaletteEditorProps {
  value: string[];
  onChange: (next: string[]) => void;
  /** When set, a hidden input emits the palette as JSON for form submission. */
  name?: string;
  /** Compact mode shrinks the swatches — useful inside the review card. */
  compact?: boolean;
}

export function ColorPaletteEditor({
  value,
  onChange,
  name,
  compact,
}: ColorPaletteEditorProps) {
  // Local state holds 5 slots even when the persisted value has fewer (sparse
  // arrays from partial entry). Empty string = no color in this slot.
  const padded = [...value];
  while (padded.length < PALETTE_SIZE) padded.push("");
  const slots = padded.slice(0, PALETTE_SIZE);

  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const setSlot = (index: number, raw: string) => {
    const next = [...slots];
    next[index] = raw;
    onChange(next.filter((s) => s.trim().length > 0));
  };

  const handleGenerate = () => {
    setError(null);
    startTransition(async () => {
      try {
        const fresh = await generatePalette();
        onChange(fresh);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Palette fetch failed");
      }
    });
  };

  const handleClear = () => {
    setError(null);
    onChange([]);
  };

  const validSlots = slots.filter((s) => s.length > 0 && isValidHex(s));
  const submitValue = JSON.stringify(
    validSlots.map((s) => normalizeHex(s)).filter((h): h is string => !!h),
  );

  const swatchPx = compact ? 32 : 44;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs uppercase tracking-wider text-(--text-muted)">
          Ink colors {validSlots.length > 0 && `· ${validSlots.length}`}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleGenerate}
            disabled={isPending}
            className={cn(
              "rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) px-2 py-1 text-[11px] font-medium",
              "hover:bg-(--surface-3) hover:text-(--text-primary)",
              "disabled:opacity-50",
            )}
          >
            {isPending ? "…" : "Generate"}
          </button>
          <button
            type="button"
            onClick={handleClear}
            className={cn(
              "rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) px-2 py-1 text-[11px] font-medium",
              "hover:bg-(--surface-3) hover:text-(--text-primary)",
            )}
          >
            Clear
          </button>
        </div>
      </div>

      <div className="grid grid-cols-5 gap-1.5">
        {slots.map((hex, i) => {
          const normalized = isValidHex(hex) ? normalizeHex(hex) : null;
          const swatchBg = normalized ?? "transparent";
          const valid = hex.length === 0 || normalized != null;
          return (
            <div key={i} className="flex flex-col gap-1">
              <input
                type="text"
                inputMode="text"
                value={hex}
                onChange={(e) => setSlot(i, e.target.value)}
                placeholder="#hex"
                aria-label={`Color slot ${i + 1}`}
                className={cn(
                  "h-7 w-full rounded-(--radius-sm) border bg-(--surface-1) px-1.5 text-center font-mono text-[10px] uppercase",
                  valid
                    ? "border-(--surface-line) text-(--text-primary)"
                    : "border-(--accent-bad) text-(--accent-bad)",
                )}
              />
              <div
                aria-hidden
                className="rounded-(--radius-sm) border border-(--surface-line)"
                style={{
                  height: swatchPx,
                  background:
                    swatchBg === "transparent"
                      ? "repeating-linear-gradient(45deg, var(--surface-2), var(--surface-2) 4px, var(--surface-1) 4px, var(--surface-1) 8px)"
                      : swatchBg,
                }}
                title={normalized ?? "empty"}
              />
            </div>
          );
        })}
      </div>

      {error && (
        <p className="text-[11px] text-(--accent-bad)">{error}</p>
      )}

      {name && <input type="hidden" name={name} value={submitValue} />}
    </div>
  );
}

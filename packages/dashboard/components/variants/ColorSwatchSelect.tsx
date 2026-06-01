"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { colorHex, isLightColor } from "@/lib/variants/gildan-colors";

/**
 * Compact, space-saving multi-select for shirt colors. Collapsed it's a single
 * trigger row showing the chosen swatches + a summary; clicking opens a popover
 * with a search box and a grid of color swatches. Same selection contract as
 * the old chip row — `selected` in, `onChange` out — so the parent's dirty /
 * persist-on-regen logic is unchanged.
 *
 * Swatches are multi-select: clicking toggles membership. Each swatch carries a
 * title (hover) and aria-pressed for keyboard / screen-reader users. The panel
 * closes on Escape or an outside click.
 */
interface Props {
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}

const MAX_TRIGGER_DOTS = 6;

export function ColorSwatchSelect({
  options,
  selected,
  onChange,
  disabled = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const panelId = useId();

  // Close on outside click or Escape while open.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Focus the search field when the panel opens.
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((c) => c.toLowerCase().includes(q));
  }, [options, query]);

  function toggle(color: string) {
    if (selected.includes(color)) {
      onChange(selected.filter((c) => c !== color));
    } else {
      onChange([...selected, color]);
    }
  }

  const summary =
    selected.length === 0
      ? "No colors — agent default"
      : selected.length <= 3
        ? selected.join(", ")
        : `${selected.slice(0, 2).join(", ")} +${selected.length - 2} more`;

  return (
    <div className="flex flex-col gap-1.5" ref={rootRef}>
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider text-(--text-muted)">
          Shirt colors
        </span>
        {selected.length > 0 && !disabled && (
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-[10px] text-(--text-muted) hover:text-(--accent-warm)"
          >
            Clear
          </button>
        )}
      </div>

      <div className="relative">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={panelId}
          className={cn(
            "flex w-full items-center gap-2 rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-2) px-2.5 py-1.5 text-left text-xs text-(--text-secondary) transition-colors",
            "hover:border-(--accent-warm)/60 disabled:cursor-not-allowed disabled:opacity-50",
            open && "border-(--accent-warm)",
          )}
        >
          <span className="flex shrink-0 items-center -space-x-1">
            {selected.slice(0, MAX_TRIGGER_DOTS).map((c) => (
              <SwatchDot key={c} color={c} />
            ))}
          </span>
          <span className="flex-1 truncate text-(--text-primary)">{summary}</span>
          {selected.length > 0 && (
            <span className="shrink-0 tabular-nums text-(--text-muted)">
              ({selected.length})
            </span>
          )}
          <Caret open={open} />
        </button>

        {open && (
          <div
            id={panelId}
            role="dialog"
            aria-label="Select shirt colors"
            className="absolute left-0 right-0 top-[calc(100%+4px)] z-20 flex flex-col gap-2 rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) p-2 shadow-lg"
          >
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search colors…"
              className="h-7 w-full rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-2) px-2 text-xs text-(--text-primary) placeholder:text-(--text-faint) focus:border-(--accent-warm) focus:outline-none"
            />
            <div className="grid max-h-56 grid-cols-9 gap-1.5 overflow-y-auto p-0.5">
              {filtered.map((color) => (
                <Swatch
                  key={color}
                  color={color}
                  active={selected.includes(color)}
                  onClick={() => toggle(color)}
                />
              ))}
              {filtered.length === 0 && (
                <p className="col-span-9 py-3 text-center text-xs text-(--text-muted)">
                  No colors match “{query}”.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SwatchDot({ color }: { color: string }) {
  const hex = colorHex(color);
  return (
    <span
      aria-hidden
      title={color}
      className="h-3.5 w-3.5 rounded-full border border-(--surface-0) ring-1 ring-(--surface-line)"
      style={{ backgroundColor: hex }}
    />
  );
}

interface SwatchProps {
  color: string;
  active: boolean;
  onClick: () => void;
}

function Swatch({ color, active, onClick }: SwatchProps) {
  const hex = colorHex(color);
  const checkClass = isLightColor(hex) ? "text-black/80" : "text-white";
  return (
    <button
      type="button"
      onClick={onClick}
      title={color}
      aria-pressed={active}
      aria-label={color}
      className={cn(
        "relative flex aspect-square w-full items-center justify-center rounded-(--radius-sm) ring-1 ring-inset transition-transform",
        active
          ? "ring-2 ring-(--accent-warm) scale-105"
          : "ring-(--surface-line) hover:scale-105",
      )}
      style={{ backgroundColor: hex }}
    >
      {active && (
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={checkClass}
          aria-hidden
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      )}
    </button>
  );
}

function Caret({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn(
        "shrink-0 text-(--text-muted) transition-transform",
        open && "rotate-180",
      )}
      aria-hidden
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

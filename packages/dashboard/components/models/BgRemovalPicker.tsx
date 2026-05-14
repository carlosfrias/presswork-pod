"use client";

import {
  BG_REMOVAL_OPTIONS,
  type BgRemovalModeId,
} from "@/lib/models/bg-removal";

/**
 * Single-select chip row for picking the per-brief background-removal
 * backend. Mirrors ImageModelPicker and StylePicker — same chip styling,
 * same null-fallback chip pattern so the operator's mental model of "pick
 * a backend, persist on regen" is identical across the three pickers.
 *
 * The Local chip (`value === null`) maps to "fall back to the global
 * runtime_flags.background_removal_mode" which is currently "local" —
 * in-process rembg, free, no fal call. Python's main.py reads
 * brief.background_removal_mode first, falls through to the runtime flag
 * when NULL. The two real chips (BiRefNet, Bria) are paid AI fallbacks
 * the designer picks when local leaves halos or eats fine detail.
 */
interface Props {
  value: BgRemovalModeId | null;
  onChange: (next: BgRemovalModeId | null) => void;
  disabled?: boolean;
  label?: string;
}

export function BgRemovalPicker({
  value,
  onChange,
  disabled = false,
  label = "Background removal (regen target)",
}: Props) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs uppercase tracking-wider text-(--text-muted)">
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5">
        <Chip
          active={value === null}
          disabled={disabled}
          onClick={() => onChange(null)}
          title="Run rembg U²-Net in the Design agent process — free, no fal call. Falls through to the global background_removal_mode runtime flag (currently 'local')."
        >
          Local
        </Chip>
        {BG_REMOVAL_OPTIONS.map((opt) => (
          <Chip
            key={opt.id}
            active={value === opt.id}
            disabled={disabled}
            onClick={() => onChange(opt.id)}
            title={opt.blurb}
          >
            {opt.label}
          </Chip>
        ))}
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

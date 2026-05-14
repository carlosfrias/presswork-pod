"use client";

import { STYLE_OPTIONS, type StyleId } from "@/lib/styles/catalog";

/**
 * Single-select chip row for picking a visual style. Used by both Builder
 * (FromScoutCard + ManualEntryForm) and Design (DesignReviewCard) so the
 * picker UI is identical wherever it appears.
 *
 * The "Auto" chip explicitly deselects — useful when the operator wants the
 * Claude prompt builder to pick a register from style_keywords instead of
 * locking to one of the six canonical styles. Disabled state freezes the
 * picker while the parent is in flight (Building / Sending / Regenerating).
 */
interface Props {
  value: StyleId | null;
  onChange: (next: StyleId | null) => void;
  disabled?: boolean;
  label?: string;
}

export function StylePicker({
  value,
  onChange,
  disabled = false,
  label = "Style",
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
          title="Let the prompt builder pick a register from style_keywords"
        >
          Auto
        </Chip>
        {STYLE_OPTIONS.map((style) => (
          <Chip
            key={style.id}
            active={value === style.id}
            disabled={disabled}
            onClick={() => onChange(style.id)}
            title={style.blurb}
          >
            {style.label}
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
  // Active state uses --accent-warm so the choice is unambiguous against
  // the surface-2 background; resting state stays quiet to avoid competing
  // with the form's primary action button.
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

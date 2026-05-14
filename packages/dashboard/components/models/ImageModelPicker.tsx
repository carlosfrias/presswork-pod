"use client";

import {
  IMAGE_MODEL_OPTIONS,
  type ImageModelId,
} from "@/lib/models/image-models";

/**
 * Single-select chip row for picking an image-generation backend. Used by
 * the Overview default-model card, Builder Send-to-Design forms, and Design
 * regen. Same component everywhere so the operator's visual model for "pick
 * a model" stays identical across surfaces.
 *
 * The `allowAuto` prop adds a leading "Default" chip that maps to null —
 * useful in Builder/Design where Auto means "use whatever the global default
 * is" rather than locking the brief to a specific backend. Overview itself
 * doesn't show Auto: it IS the default, you can't defer.
 */
interface Props {
  value: ImageModelId | null;
  onChange: (next: ImageModelId | null) => void;
  disabled?: boolean;
  label?: string;
  allowAuto?: boolean;
}

export function ImageModelPicker({
  value,
  onChange,
  disabled = false,
  label = "Image model",
  allowAuto = false,
}: Props) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs uppercase tracking-wider text-(--text-muted)">
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {allowAuto && (
          <Chip
            active={value === null}
            disabled={disabled}
            onClick={() => onChange(null)}
            title="Use the global default model set on the Overview page."
          >
            Default
          </Chip>
        )}
        {IMAGE_MODEL_OPTIONS.map((model) => (
          <Chip
            key={model.id}
            active={value === model.id}
            disabled={disabled}
            onClick={() => onChange(model.id)}
            title={`${model.blurb} — ${model.costHint}`}
          >
            {model.label}
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

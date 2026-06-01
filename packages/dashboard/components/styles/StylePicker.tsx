"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { STYLE_OPTIONS, type StyleId } from "@/lib/styles/catalog";

/**
 * Single-select dropdown for picking a visual style. Used by both Builder
 * (FromScoutCard + ManualEntryForm) and Design (DesignReviewCard) so the
 * picker UI is identical wherever it appears.
 *
 * Collapsed it's a one-line trigger showing the current style; clicking opens
 * a popover list of styles (label + blurb). Keeps the card compact instead of
 * a wrapping row of 13 chips. Selecting a row closes the panel.
 *
 * The "Auto" row explicitly deselects (value === null) — useful when the
 * operator wants the Claude prompt builder to pick a register from
 * style_keywords instead of locking to one of the canonical styles. Disabled
 * state freezes the picker while the parent is in flight (Building / Sending /
 * Regenerating). The panel closes on Escape or an outside click.
 */
interface Props {
  value: StyleId | null;
  onChange: (next: StyleId | null) => void;
  disabled?: boolean;
  label?: string;
}

const AUTO_BLURB =
  "Let the prompt builder pick a register from style_keywords.";

export function StylePicker({
  value,
  onChange,
  disabled = false,
  label = "Style",
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

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

  const selected = value
    ? STYLE_OPTIONS.find((s) => s.id === value)
    : undefined;
  const triggerLabel = selected?.label ?? "Auto";
  const triggerBlurb = selected?.blurb ?? AUTO_BLURB;

  function select(next: StyleId | null) {
    onChange(next);
    setOpen(false);
  }

  return (
    <div className="flex flex-col gap-1.5" ref={rootRef}>
      <span className="text-xs uppercase tracking-wider text-(--text-muted)">
        {label}
      </span>

      <div className="relative">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={panelId}
          title={triggerBlurb}
          className={cn(
            "flex w-full items-center gap-2 rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-2) px-2.5 py-1.5 text-left text-xs transition-colors",
            "hover:border-(--accent-warm)/60 disabled:cursor-not-allowed disabled:opacity-50",
            open && "border-(--accent-warm)",
          )}
        >
          <span className="flex-1 truncate text-(--text-primary)">
            {triggerLabel}
          </span>
          <Caret open={open} />
        </button>

        {open && (
          <ul
            id={panelId}
            role="listbox"
            aria-label="Visual style"
            className="absolute left-0 right-0 top-[calc(100%+4px)] z-20 max-h-72 overflow-y-auto rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) p-1 shadow-lg"
          >
            <Row
              active={value === null}
              label="Auto"
              blurb={AUTO_BLURB}
              onClick={() => select(null)}
            />
            {STYLE_OPTIONS.map((style) => (
              <Row
                key={style.id}
                active={value === style.id}
                label={style.label}
                blurb={style.blurb}
                onClick={() => select(style.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface RowProps {
  active: boolean;
  label: string;
  blurb: string;
  onClick: () => void;
}

function Row({ active, label, blurb, onClick }: RowProps) {
  return (
    <li role="option" aria-selected={active}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex w-full items-start gap-2 rounded-(--radius-sm) px-2 py-1.5 text-left transition-colors",
          active
            ? "bg-(--accent-warm)/15"
            : "hover:bg-(--surface-2)",
        )}
      >
        <Check visible={active} />
        <span className="flex min-w-0 flex-col">
          <span
            className={cn(
              "text-xs",
              active ? "text-(--text-primary)" : "text-(--text-secondary)",
            )}
          >
            {label}
          </span>
          <span className="text-[10px] leading-snug text-(--text-muted)">
            {blurb}
          </span>
        </span>
      </button>
    </li>
  );
}

function Check({ visible }: { visible: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn(
        "mt-0.5 shrink-0 text-(--accent-warm)",
        visible ? "opacity-100" : "opacity-0",
      )}
      aria-hidden
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
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

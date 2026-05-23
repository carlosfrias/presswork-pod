"use client";

import { useState } from "react";
import { Button } from "./Button";

interface ConfirmDeleteProps {
  /**
   * The server action to call when the user confirms. The action will receive
   * a FormData with `id`.
   */
  action: (formData: FormData) => Promise<void>;
  id: string;
  /** Button label when collapsed. */
  label?: string;
  /** Optional helper text shown next to Confirm. */
  helper?: string;
  /**
   * When true, renders a locked/disabled state instead of the interactive
   * button. Use when deletion is blocked by downstream dependencies.
   */
  locked?: boolean;
  /** Tooltip shown on the locked button. */
  lockedTitle?: string;
}

/**
 * Two-step destructive confirm — single button at rest, expands into
 * Cancel / Confirm when clicked. Deliberately *not* a disclosure (`<details>`)
 * so it can't be confused with non-destructive actions on the same card.
 */
export function ConfirmDelete({
  action,
  id,
  label = "Delete",
  helper,
  locked,
  lockedTitle,
}: ConfirmDeleteProps) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (locked) {
    return (
      <button
        type="button"
        disabled
        title={lockedTitle}
        className="flex w-full items-center justify-center gap-1.5 rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) px-3 py-1.5 text-xs font-medium text-(--text-faint) opacity-60 cursor-not-allowed"
      >
        <LockIcon />
        {label}
      </button>
    );
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="w-full rounded-(--radius-sm) border border-(--accent-bad)/30 bg-(--accent-bad)/10 px-3 py-1.5 text-xs font-medium text-(--accent-bad) hover:bg-(--accent-bad)/20"
      >
        {label}
      </button>
    );
  }

  return (
    <form
      action={async (fd) => {
        setPending(true);
        setError(null);
        try {
          await action(fd);
        } catch (e) {
          setError(e instanceof Error ? e.message : "Delete failed");
          setPending(false);
        }
      }}
      className="flex flex-col gap-1.5"
    >
      <input type="hidden" name="id" value={id} />
      {helper && <span className="text-xs text-(--text-muted)">{helper}</span>}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="flex-1"
          onClick={() => {
            setConfirming(false);
            setError(null);
          }}
          disabled={pending}
        >
          Cancel
        </Button>
        <Button type="submit" variant="danger" size="sm" className="flex-1" disabled={pending}>
          {pending ? "Deleting…" : "Delete"}
        </Button>
      </div>
      {error && <span className="text-xs text-(--accent-bad)">{error}</span>}
    </form>
  );
}

function LockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

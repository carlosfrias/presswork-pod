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
}

/**
 * Two-step destructive confirm — single button at rest, expands into
 * Cancel / Confirm when clicked. Deliberately *not* a disclosure (`<details>`)
 * so it can't be confused with non-destructive actions on the same card.
 */
export function ConfirmDelete({ action, id, label = "Delete", helper }: ConfirmDeleteProps) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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

"use client";

import { useState, useTransition } from "react";
import { ImageModelPicker } from "@/components/models/ImageModelPicker";
import { setRuntimeFlag } from "@/lib/actions/flags";
import {
  getImageModel,
  type ImageModelId,
} from "@/lib/models/image-models";

/**
 * Overview-page card for the global default image model. Backed by the
 * `default_image_model` runtime flag (seeded by migration 036).
 *
 * Clicking a chip writes the flag immediately — no separate save button.
 * The transition keeps the chip in the optimistic new state while the
 * write is in flight; if the server action throws the chip reverts. Cost
 * hint refreshes alongside the chip so the operator can see at a glance
 * what they're choosing into.
 */
interface Props {
  initial: ImageModelId;
}

export function DefaultImageModelCard({ initial }: Props) {
  const [current, setCurrent] = useState<ImageModelId>(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleChange(next: ImageModelId | null) {
    if (next === null) return; // Overview picker doesn't expose Auto.
    if (next === current) return;
    const previous = current;
    setCurrent(next); // Optimistic.
    setError(null);
    startTransition(async () => {
      try {
        const fd = new FormData();
        fd.set("key", "default_image_model");
        // setRuntimeFlag JSON.parses the value — wrap in quotes so it lands
        // as a JSON string in the JSONB column, matching the migration seed.
        fd.set("value", JSON.stringify(next));
        await setRuntimeFlag(fd);
      } catch (err) {
        setCurrent(previous);
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  const selected = getImageModel(current);

  return (
    <div className="flex flex-col gap-3">
      <ImageModelPicker
        value={current}
        onChange={handleChange}
        disabled={pending}
        label="Default for new briefs"
      />
      {selected && (
        <div className="rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) p-3 text-xs text-(--text-secondary)">
          <div className="font-medium text-(--text-primary)">{selected.label}</div>
          <p className="mt-1">{selected.blurb}</p>
          <p className="mt-1 text-(--text-muted)">{selected.costHint}</p>
        </div>
      )}
      {pending && (
        <span className="text-[11px] text-(--text-muted)">Saving…</span>
      )}
      {error && (
        <span className="text-[11px] text-(--accent-bad)">{error}</span>
      )}
    </div>
  );
}

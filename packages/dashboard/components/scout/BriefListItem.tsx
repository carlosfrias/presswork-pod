"use client";

import { useState, useTransition } from "react";
import { StatusBadge } from "@/components/status/StatusBadge";
import { Button } from "@/components/ui/Button";
import { ConfirmDelete } from "@/components/ui/ConfirmDelete";
import { formatRelative, formatUsd } from "@/lib/format";
import type { TrendBriefRow } from "@/lib/queries/types";
import { deleteBrief, editBrief, retryBrief } from "@/lib/actions/scout";

const READ_ONLY_STATUSES = new Set(["processing", "done"]);

export function BriefListItem({ brief }: { brief: TrendBriefRow }) {
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, startSave] = useTransition();

  const readOnly = READ_ONLY_STATUSES.has(brief.status);

  function handleSave(formData: FormData) {
    setError(null);
    startSave(async () => {
      try {
        await editBrief(formData);
        setIsEditing(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  return (
    <li className="flex flex-col gap-3 rounded-(--radius-lg) border border-(--surface-line) bg-(--surface-2) p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-display text-base font-semibold text-(--text-primary)">
            {brief.niche}
          </h3>
          <p className="mt-0.5 text-xs text-(--text-muted)">
            <span suppressHydrationWarning>{formatRelative(brief.created_at)}</span>
            {brief.price_target_usd != null && ` · ${formatUsd(brief.price_target_usd)} target`}
          </p>
        </div>
        <StatusBadge status={brief.status} />
      </div>

      {!isEditing && brief.style_keywords && brief.style_keywords.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {brief.style_keywords.slice(0, 6).map((k) => (
            <span
              key={k}
              className="rounded-(--radius-sm) bg-(--surface-1) px-2 py-0.5 text-xs text-(--text-secondary)"
            >
              {k}
            </span>
          ))}
        </div>
      )}

      {!isEditing && brief.color_palette && brief.color_palette.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-(--text-muted)">
            Palette
          </span>
          <div className="flex gap-1.5">
            {brief.color_palette.slice(0, 8).map((c, i) => (
              <span
                key={`${c}-${i}`}
                title={c}
                aria-label={`Color ${c}`}
                className="h-4 w-4 rounded-full border border-(--surface-line)"
                style={{ background: c }}
              />
            ))}
          </div>
        </div>
      )}

      {!isEditing && brief.error_message && (
        <div className="rounded-(--radius-sm) bg-(--accent-bad)/10 p-2 text-xs text-(--accent-bad)">
          {brief.error_message}
        </div>
      )}

      {isEditing && (
        <form action={handleSave} className="flex flex-col gap-2.5">
          <input type="hidden" name="id" value={brief.id} />
          <EditField
            label="Niche"
            name="niche"
            defaultValue={brief.niche}
            required
          />
          <EditField
            label="Style keywords (comma-separated)"
            name="style_keywords"
            defaultValue={(brief.style_keywords ?? []).join(", ")}
            placeholder="screen print, bold, vintage"
          />
          <EditField
            label="Top tags (comma-separated)"
            name="top_tags"
            defaultValue={(brief.top_tags ?? []).join(", ")}
            placeholder="bulldog shirt, funny dog tee"
          />
          <EditField
            label="Color palette (comma-separated)"
            name="color_palette"
            defaultValue={(brief.color_palette ?? []).join(", ")}
            placeholder="#c8a532, #6b7a3a, #f4ead0"
          />
          <EditField
            label="Price target USD"
            name="price_target_usd"
            type="number"
            step="0.01"
            defaultValue={
              brief.price_target_usd != null ? String(brief.price_target_usd) : ""
            }
            placeholder="24.99"
          />
          {error && (
            <span className="text-xs text-(--accent-bad)">{error}</span>
          )}
          <div className="flex items-center gap-2">
            <Button type="submit" variant="primary" size="sm" disabled={isSaving}>
              {isSaving ? "Saving…" : "Save"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setIsEditing(false);
                setError(null);
              }}
              disabled={isSaving}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}

      {!isEditing && (
        <div className="mt-auto flex items-center gap-2">
          {brief.status === "error" && (
            <form action={retryBrief}>
              <input type="hidden" name="id" value={brief.id} />
              <Button type="submit" size="sm" variant="ghost">
                Retry
              </Button>
            </form>
          )}
          {!readOnly && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setIsEditing(true)}
            >
              Edit
            </Button>
          )}
          <div className="ml-auto w-36">
            <ConfirmDelete action={deleteBrief} id={brief.id} helper="Really?" />
          </div>
        </div>
      )}
    </li>
  );
}

function EditField({
  label,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wider text-(--text-muted)">
      {label}
      <input
        {...rest}
        className="h-8 rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) px-2 text-sm text-(--text-primary) normal-case tracking-normal focus:border-(--accent-warm) focus:outline-none"
      />
    </label>
  );
}

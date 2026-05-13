"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import {
  buildPromptForBrief,
  sendToDesign,
  type BuildResult,
} from "@/lib/actions/builder";
import type { TrendBriefRow } from "@/lib/queries/types";

interface Props {
  brief: TrendBriefRow;
}

/** From-Scout Builder card.
 *
 * Three states the operator moves through:
 *   1. Seed empty / no build yet → only the seed textarea is interactive.
 *   2. Build in flight → buttons disabled, "Building…" indicator.
 *   3. Build returned → editable description textarea + Send / Rebuild.
 *
 * Rebuild re-runs Claude with the same seed (operator can also edit the seed
 * first and then rebuild). Description state is local; nothing hits the DB
 * until Send to Design submits the sendToDesign action.
 */
export function FromScoutCard({ brief }: Props) {
  const [seed, setSeed] = useState("");
  const [referenceUrl, setReferenceUrl] = useState("");
  const [description, setDescription] = useState("");
  const [buildError, setBuildError] = useState<string | null>(null);
  // Count of designs spawned from this brief in the current session. The
  // parent brief is not consumed on Send — each Send forks a child brief
  // into Design's queue. This counter is in-memory only; on page reload it
  // resets but the spawned children remain in the pipeline.
  const [sentCount, setSentCount] = useState(0);
  const [isBuilding, startBuild] = useTransition();
  const [isSending, startSend] = useTransition();

  const created = new Date(brief.created_at).toISOString().slice(0, 10);

  function handleBuild() {
    setBuildError(null);
    startBuild(async () => {
      const result: BuildResult = await buildPromptForBrief(
        brief.id,
        seed,
        referenceUrl,
      );
      if (result.ok) {
        setDescription(result.description);
      } else {
        setBuildError(result.error);
      }
    });
  }

  function handleSend(formData: FormData) {
    formData.set("id", brief.id);
    formData.set("description", description);
    startSend(async () => {
      await sendToDesign(formData);
      // Don't reset state — the operator commonly iterates: send → tweak seed
      // → rebuild → send again. The brief stays in the Builder queue (it's
      // never consumed), so we keep the card hot for the next variation.
      setSentCount((n) => n + 1);
    });
  }

  function handleReset() {
    setSeed("");
    setReferenceUrl("");
    setDescription("");
    setBuildError(null);
    setSentCount(0);
  }

  const canBuild = seed.trim().length >= 3 && !isBuilding && !isSending;
  const canSend = description.trim().length >= 10 && !isBuilding && !isSending;
  const hasBuilt = description.length > 0;

  return (
    <div className="flex flex-col gap-3 rounded-(--radius-md) border border-(--surface-line) bg-(--surface-1) p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-(--text-primary)">{brief.niche}</span>
            {sentCount > 0 && (
              <span
                className="rounded-(--radius-sm) bg-(--accent-good)/15 px-2 py-0.5 text-[11px] font-medium text-(--accent-good)"
                title="Designs sent from this brief in the current session"
              >
                Sent {sentCount} ✓
              </span>
            )}
          </div>
          <span className="font-mono text-[11px] text-(--text-muted)">
            {brief.id.slice(0, 8)} · {created}
          </span>
        </div>
        {brief.style_keywords && brief.style_keywords.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {brief.style_keywords.slice(0, 6).map((kw) => (
              <span
                key={kw}
                className="rounded-(--radius-sm) bg-(--surface-2) px-2 py-0.5 text-[11px] text-(--text-secondary)"
              >
                {kw}
              </span>
            ))}
          </div>
        )}
      </div>

      {brief.color_palette && brief.color_palette.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-(--text-muted)">
            Palette
          </span>
          <div className="flex gap-1">
            {brief.color_palette.slice(0, 8).map((c) => (
              <span
                key={c}
                title={c}
                className="inline-block h-4 w-4 rounded-(--radius-sm) border border-(--surface-line)"
                style={{ background: c }}
              />
            ))}
          </div>
        </div>
      )}

      <label className="flex flex-col gap-1.5 text-xs uppercase tracking-wider text-(--text-muted)">
        Seed
        <textarea
          name="seed"
          value={seed}
          onChange={(e) => setSeed(e.target.value)}
          rows={2}
          maxLength={1000}
          placeholder="e.g. bulldog trashman — or be specific: bulldog trashman, screen print, mustard + olive"
          className="rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-0) px-3 py-2 text-sm text-(--text-primary) normal-case tracking-normal focus:border-(--accent-warm) focus:outline-none"
          disabled={isBuilding || isSending}
        />
        <span className="text-[11px] normal-case tracking-normal text-(--text-muted)">
          Free-form. Anything you name (style, palette, scene) stays locked. Builder fills the rest using Scout&apos;s signals as priors.
        </span>
      </label>

      <label className="flex flex-col gap-1.5 text-xs uppercase tracking-wider text-(--text-muted)">
        Reference image URL(s) (optional, comma-separated, up to 3)
        <input
          type="text"
          value={referenceUrl}
          onChange={(e) => setReferenceUrl(e.target.value)}
          maxLength={6000}
          placeholder="https://upload.wikimedia.org/.../Girl_with_a_Pearl_Earring.jpg, https://..."
          className="h-9 rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-0) px-3 text-sm text-(--text-primary) normal-case tracking-normal focus:border-(--accent-warm) focus:outline-none"
          disabled={isBuilding || isSending}
        />
        <span className="text-[11px] normal-case tracking-normal text-(--text-muted)">
          Public URLs only. With 1 image, Builder treats it as composition + palette anchor. With 2-3, Builder splits roles by position: image 1 = composition, image 2 = style register, image 3 = palette/mood. Your seed can override any of those.
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant={hasBuilt ? "secondary" : "primary"}
          onClick={handleBuild}
          disabled={!canBuild}
        >
          {isBuilding ? "Building…" : hasBuilt ? "Rebuild" : "Build prompt"}
        </Button>
        {(hasBuilt || seed.length > 0 || referenceUrl.length > 0) && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleReset}
            disabled={isBuilding || isSending}
          >
            Clear
          </Button>
        )}
        {buildError && (
          <span className="text-xs text-(--accent-bad)">{buildError}</span>
        )}
      </div>

      {hasBuilt && (
        <form action={handleSend} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-xs uppercase tracking-wider text-(--text-muted)">
            Description (editable)
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={5}
              maxLength={2000}
              className="rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-0) px-3 py-2 text-sm text-(--text-primary) normal-case tracking-normal focus:border-(--accent-warm) focus:outline-none"
              disabled={isSending}
            />
          </label>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" disabled={!canSend}>
              {isSending ? "Sending…" : "Send to Design"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

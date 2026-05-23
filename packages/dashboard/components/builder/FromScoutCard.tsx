"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { StylePicker } from "@/components/styles/StylePicker";
import { ImageModelPicker } from "@/components/models/ImageModelPicker";
import {
  buildPromptForBrief,
  sendToDesign,
  type BuildResult,
} from "@/lib/actions/builder";
import type { StyleId } from "@/lib/styles/catalog";
import type { ImageModelId } from "@/lib/models/image-models";
import type { TrendBriefRow } from "@/lib/queries/types";

interface Props {
  brief: TrendBriefRow;
  // Global default image model from the Overview flag. Used as the initial
  // picker value — operator can override per Send.
  defaultImageModel: ImageModelId;
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
export function FromScoutCard({ brief, defaultImageModel }: Props) {
  const [seed, setSeed] = useState("");
  const [referenceUrl, setReferenceUrl] = useState("");
  const [artReference, setArtReference] = useState("");
  const [textInDesign, setTextInDesign] = useState("");
  const [poseAction, setPoseAction] = useState("");
  const [style, setStyle] = useState<StyleId | null>(null);
  // Image-model chip. Seeded with the global default; operator overrides per
  // Send. Persisted on the spawned child brief via the form's hidden field.
  const [imageModel, setImageModel] = useState<ImageModelId>(defaultImageModel);
  const [description, setDescription] = useState("");
  const [buildError, setBuildError] = useState<string | null>(null);
  // Count of designs spawned from this brief in the current session. The
  // parent brief is not consumed on Send — each Send forks a child brief
  // into Design's queue. This counter is in-memory only; on page reload it
  // resets but the spawned children remain in the pipeline.
  const [sentCount, setSentCount] = useState(0);
  // Snapshot of the description text at the moment of the last successful
  // Send. The button compares against this to block accidental double-sends
  // of the same description. Cleared by Rebuild or by any edit to the
  // textarea (the strings simply diverge).
  const [lastSentDescription, setLastSentDescription] = useState<string | null>(null);
  const [isBuilding, startBuild] = useTransition();
  const [isSending, startSend] = useTransition();
  // Collapsible state. Cards default collapsed for a scannable queue. The
  // operator clicks the header to expand and start building. Nothing here is
  // persisted — the prompt only reaches the DB when Send to Design fires
  // (sendToDesign writes image_description on the spawned child brief). On
  // page reload, every card returns to collapsed.
  const [isExpanded, setIsExpanded] = useState(false);

  const created = new Date(brief.created_at).toISOString().slice(0, 10);

  function handleBuild() {
    setBuildError(null);
    startBuild(async () => {
      const result: BuildResult = await buildPromptForBrief(
        brief.id,
        seed,
        referenceUrl,
        style,
        artReference || null,
        textInDesign || null,
        poseAction || null,
      );
      if (result.ok) {
        setDescription(result.description);
        // Rebuild produces a fresh description; clear the dedupe guard so
        // the new text is sendable even if it happens to match the prior.
        setLastSentDescription(null);
      } else {
        setBuildError(result.error);
      }
    });
  }

  function handleSend(formData: FormData) {
    const snapshot = description;
    formData.set("id", brief.id);
    formData.set("description", snapshot);
    // Persist the chip choice on the child brief so Design review can
    // surface it. Empty string when Auto — server collapses bad/empty
    // values back to null via parseStyle.
    formData.set("style", style ?? "");
    formData.set("image_model", imageModel);
    startSend(async () => {
      await sendToDesign(formData);
      // Don't reset state — the operator commonly iterates: send → tweak seed
      // → rebuild → send again. The brief stays in the Builder queue (it's
      // never consumed), so we keep the card hot for the next variation.
      // Remember the exact text we just sent so the Send button locks until
      // the operator edits the description or rebuilds.
      setLastSentDescription(snapshot);
      setSentCount((n) => n + 1);
    });
  }

  function handleReset() {
    setSeed("");
    setReferenceUrl("");
    setArtReference("");
    setTextInDesign("");
    setPoseAction("");
    setStyle(null);
    setDescription("");
    setBuildError(null);
    setSentCount(0);
    setLastSentDescription(null);
  }

  const canBuild = seed.trim().length >= 3 && !isBuilding && !isSending;
  const isUnchangedSinceSend =
    lastSentDescription !== null && description === lastSentDescription;
  const canSend =
    description.trim().length >= 10 &&
    !isBuilding &&
    !isSending &&
    !isUnchangedSinceSend;
  const hasBuilt = description.length > 0;

  return (
    <div className="flex flex-col gap-3 rounded-(--radius-md) border border-(--surface-line) bg-(--surface-1) p-4">
      <button
        type="button"
        onClick={() => setIsExpanded((v) => !v)}
        className="flex w-full flex-wrap items-baseline justify-between gap-3 text-left"
        aria-expanded={isExpanded}
      >
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span aria-hidden className="text-(--text-muted) tabular">
              {isExpanded ? "▾" : "▸"}
            </span>
            <span className="text-sm font-medium text-(--text-primary)">{brief.niche}</span>
            {sentCount > 0 && (
              <span
                className="rounded-(--radius-sm) bg-(--accent-good)/15 px-2 py-0.5 text-[11px] font-medium text-(--accent-good)"
                title="Designs sent from this brief in the current session"
              >
                Sent {sentCount} ✓
              </span>
            )}
            {!isExpanded && brief.color_palette && brief.color_palette.length > 0 && (
              <span className="ml-1 flex gap-0.5">
                {brief.color_palette.slice(0, 5).map((c) => (
                  <span
                    key={c}
                    title={c}
                    className="inline-block h-3 w-3 rounded-(--radius-sm) border border-(--surface-line)"
                    style={{ background: c }}
                  />
                ))}
              </span>
            )}
          </div>
          <span className="font-mono text-[11px] text-(--text-muted)">
            {brief.id.slice(0, 8)} · {created}
          </span>
        </div>
        {brief.style_keywords && brief.style_keywords.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {brief.style_keywords
              .slice(0, isExpanded ? 6 : 3)
              .map((kw) => (
                <span
                  key={kw}
                  className="rounded-(--radius-sm) bg-(--surface-2) px-2 py-0.5 text-[11px] text-(--text-secondary)"
                >
                  {kw}
                </span>
              ))}
          </div>
        )}
      </button>

      {!isExpanded ? null : (
        <>
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
          Direct image URLs only (.jpg / .png / .webp). On a webpage, right-click the image → &ldquo;Copy image address&rdquo;. Share links and Google/Pinterest page URLs return HTML, not image bytes, and will fail. With 1 image, Builder treats it as composition + palette anchor. With 2-3, Builder splits roles by position: image 1 = composition, image 2 = style register, image 3 = palette/mood. Your seed can override any of those.
        </span>
      </label>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1.5 text-xs uppercase tracking-wider text-(--text-muted)">
          Art / cultural ref
          <input
            type="text"
            value={artReference}
            onChange={(e) => setArtReference(e.target.value)}
            maxLength={200}
            placeholder="Andy Warhol banana · ukiyo-e woodblock · Street Fighter crouch"
            className="h-9 rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-0) px-3 text-sm text-(--text-primary) normal-case tracking-normal focus:border-(--accent-warm) focus:outline-none"
            disabled={isBuilding || isSending}
          />
          <span className="text-[11px] normal-case tracking-normal text-(--text-muted)">
            Named movement, artist, or crossover. Locks the style/composition anchor.
          </span>
        </label>

        <label className="flex flex-col gap-1.5 text-xs uppercase tracking-wider text-(--text-muted)">
          Text in design
          <input
            type="text"
            value={textInDesign}
            onChange={(e) => setTextInDesign(e.target.value)}
            maxLength={100}
            placeholder="Dam it · Let's start a Kerfuffle"
            className="h-9 rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-0) px-3 text-sm text-(--text-primary) normal-case tracking-normal focus:border-(--accent-warm) focus:outline-none"
            disabled={isBuilding || isSending}
          />
          <span className="text-[11px] normal-case tracking-normal text-(--text-muted)">
            Exact lettering to embed in the image. Verbatim — never paraphrased.
          </span>
        </label>

        <label className="flex flex-col gap-1.5 text-xs uppercase tracking-wider text-(--text-muted)">
          Pose / action
          <input
            type="text"
            value={poseAction}
            onChange={(e) => setPoseAction(e.target.value)}
            maxLength={200}
            placeholder="Raising one hand in triumph · crouched arms extended"
            className="h-9 rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-0) px-3 text-sm text-(--text-primary) normal-case tracking-normal focus:border-(--accent-warm) focus:outline-none"
            disabled={isBuilding || isSending}
          />
          <span className="text-[11px] normal-case tracking-normal text-(--text-muted)">
            Specific physical action or emotional beat. Locks the character&apos;s moment.
          </span>
        </label>
      </div>

      <StylePicker
        value={style}
        onChange={setStyle}
        disabled={isBuilding || isSending}
      />

      <ImageModelPicker
        value={imageModel}
        onChange={(next) => next && setImageModel(next)}
        disabled={isBuilding || isSending}
      />

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
          <div className="flex items-center justify-end gap-2">
            {isUnchangedSinceSend && (
              <span className="text-[11px] text-(--text-muted)">
                Edit the description or rebuild to send another variant.
              </span>
            )}
            <Button type="submit" variant="primary" disabled={!canSend}>
              {isSending
                ? "Sending…"
                : isUnchangedSinceSend
                  ? "Sent ✓"
                  : "Send to Design"}
            </Button>
          </div>
        </form>
      )}
        </>
      )}
    </div>
  );
}

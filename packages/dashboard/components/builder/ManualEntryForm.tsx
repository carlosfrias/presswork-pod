"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import {
  buildPromptManual,
  createManualBrief,
  type BuildResult,
} from "@/lib/actions/builder";

/** Manual Builder entry.
 *
 * Same three-state flow as FromScoutCard but with no Scout priors — Builder
 * picks style + palette + scene cold. Operator picks the niche or leaves the
 * field blank to fall back to the "original design" default.
 */
export function ManualEntryForm() {
  const [niche, setNiche] = useState("");
  const [seed, setSeed] = useState("");
  const [referenceUrl, setReferenceUrl] = useState("");
  const [description, setDescription] = useState("");
  const [buildError, setBuildError] = useState<string | null>(null);
  const [isBuilding, startBuild] = useTransition();
  const [isSending, startSend] = useTransition();

  function handleBuild() {
    setBuildError(null);
    startBuild(async () => {
      const result: BuildResult = await buildPromptManual(seed, referenceUrl);
      if (result.ok) {
        setDescription(result.description);
      } else {
        setBuildError(result.error);
      }
    });
  }

  function handleSend(formData: FormData) {
    formData.set("niche", niche);
    formData.set("description", description);
    startSend(async () => {
      await createManualBrief(formData);
      // Reset on successful create so the operator can queue another one
      // without a page refresh. revalidatePath inside createManualBrief
      // refreshes the Design page; this clears the form locally.
      setNiche("");
      setSeed("");
      setReferenceUrl("");
      setDescription("");
    });
  }

  const canBuild = seed.trim().length >= 3 && !isBuilding && !isSending;
  const canSend = description.trim().length >= 10 && !isBuilding && !isSending;
  const hasBuilt = description.length > 0;

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5 text-xs uppercase tracking-wider text-(--text-muted)">
        Niche
        <input
          type="text"
          value={niche}
          onChange={(e) => setNiche(e.target.value)}
          maxLength={120}
          placeholder="original design"
          className="h-9 rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) px-3 text-sm text-(--text-primary) normal-case tracking-normal focus:border-(--accent-warm) focus:outline-none"
          disabled={isBuilding || isSending}
        />
        <span className="text-[11px] normal-case tracking-normal text-(--text-muted)">
          Leave blank to use the default &ldquo;original design&rdquo;.
        </span>
      </label>

      <label className="flex flex-col gap-1.5 text-xs uppercase tracking-wider text-(--text-muted)">
        Seed
        <textarea
          value={seed}
          onChange={(e) => setSeed(e.target.value)}
          rows={2}
          maxLength={1000}
          placeholder="e.g. frog knight — or be specific: frog knight, ink illustration, muted moss-green palette, sword resting on the ground"
          className="rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) px-3 py-2 text-sm text-(--text-primary) normal-case tracking-normal focus:border-(--accent-warm) focus:outline-none"
          disabled={isBuilding || isSending}
        />
        <span className="text-[11px] normal-case tracking-normal text-(--text-muted)">
          Free-form. Anything you name (style, palette, scene) stays locked. Builder fills the rest.
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
          className="h-9 rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) px-3 text-sm text-(--text-primary) normal-case tracking-normal focus:border-(--accent-warm) focus:outline-none"
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
              rows={6}
              maxLength={2000}
              className="rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) px-3 py-2 text-sm text-(--text-primary) normal-case tracking-normal focus:border-(--accent-warm) focus:outline-none"
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

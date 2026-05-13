"use client";

import { useState } from "react";
import { injectDesign } from "@/lib/actions/design";
import { Button } from "@/components/ui/Button";
import { ColorPaletteEditor } from "@/components/design/ColorPaletteEditor";

type ImageModel = "fal_flux_pro" | "fal_gpt_image_2";
type ImageQuality = "low" | "medium" | "high";

const REQUIRED_TERMS = ["print on demand design", "vector-style"];
const REQUIRED_BACKGROUND_TERMS = ["white background", "black background"];

const SELECT_CLS =
  "h-9 rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) px-3 text-sm text-(--text-primary)";

export function InjectDesignForm() {
  const [imageModel, setImageModel] = useState<ImageModel>("fal_gpt_image_2");
  const [imageQuality, setImageQuality] = useState<ImageQuality>("medium");
  const [palette, setPalette] = useState<string[]>([]);
  const isFlux = imageModel === "fal_flux_pro";

  return (
    <form action={injectDesign} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5 text-xs uppercase tracking-wider text-(--text-muted)">
        Niche (for labeling)
        <input
          name="niche"
          required
          placeholder="dark fantasy / solar punk / etc."
          defaultValue="dark fantasy"
          className="h-9 rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) px-3 text-sm text-(--text-primary)"
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1.5 text-xs uppercase tracking-wider text-(--text-muted)">
          Image model
          <select
            name="image_model"
            value={imageModel}
            onChange={(e) => setImageModel(e.target.value as ImageModel)}
            className={SELECT_CLS}
          >
            <option value="fal_gpt_image_2">GPT Image 2 (default)</option>
            <option value="fal_flux_pro">FLUX Pro 1.1</option>
          </select>
        </label>

        <label className="flex flex-col gap-1.5 text-xs uppercase tracking-wider text-(--text-muted)">
          Quality {isFlux && <span className="lowercase">(gpt-image-2 only)</span>}
          <select
            name="image_quality"
            value={imageQuality}
            onChange={(e) => setImageQuality(e.target.value as ImageQuality)}
            disabled={isFlux}
            className={`${SELECT_CLS} disabled:opacity-50`}
          >
            <option value="low">low (~$0.01)</option>
            <option value="medium">medium (~$0.08)</option>
            <option value="high">high (~$0.30)</option>
          </select>
        </label>
      </div>

      <label className="flex flex-col gap-1.5 text-xs uppercase tracking-wider text-(--text-muted)">
        Custom prompt
        <textarea
          name="custom_flux_prompt"
          required
          rows={5}
          placeholder={
            isFlux
              ? "print on demand design, vector-style of a..., white background"
              : "A single centered illustration of a... Plain background."
          }
          className="rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) p-3 text-sm text-(--text-primary) font-mono"
        />
        {isFlux ? (
          <span className="text-[11px] normal-case tracking-normal text-(--text-muted)">
            Skips Claude. Must contain:{" "}
            {REQUIRED_TERMS.map((t, i) => (
              <span key={t}>
                <code className="rounded bg-(--surface-2) px-1 text-(--text-secondary)">
                  {t}
                </code>
                {i < REQUIRED_TERMS.length - 1 ? ", " : ""}
              </span>
            ))}
            , plus one of:{" "}
            {REQUIRED_BACKGROUND_TERMS.map((t, i) => (
              <span key={t}>
                <code className="rounded bg-(--surface-2) px-1 text-(--text-secondary)">
                  {t}
                </code>
                {i < REQUIRED_BACKGROUND_TERMS.length - 1 ? " or " : ""}
              </span>
            ))}
            .
          </span>
        ) : (
          <span className="text-[11px] normal-case tracking-normal text-(--text-muted)">
            Skips Claude. Natural English — gpt-image-2 follows literal prompts.
            Describe a single centered subject; do not invent scenery beyond what
            you want rendered.
          </span>
        )}
      </label>

      <ColorPaletteEditor
        value={palette}
        onChange={setPalette}
        name="color_palette"
      />

      <div className="flex justify-end">
        <Button type="submit" variant="primary">
          Inject design
        </Button>
      </div>
    </form>
  );
}

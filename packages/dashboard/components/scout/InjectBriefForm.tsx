"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { generateBriefDraft, injectBrief } from "@/lib/actions/scout";

// Controlled fields so "Generate" can stuff Claude's response in. Each value
// is the string representation the operator sees in the input — arrays come
// back from Claude joined as ", " separated, and the existing injectBrief
// server action parses them back into arrays on submit.
interface FormState {
  niche: string;
  style_keywords: string;
  top_tags: string;
  color_palette: string;
  price_target_usd: string;
}

const EMPTY_STATE: FormState = {
  niche: "",
  style_keywords: "",
  top_tags: "",
  color_palette: "",
  price_target_usd: "",
};

export function InjectBriefForm() {
  const [hint, setHint] = useState("");
  const [fields, setFields] = useState<FormState>(EMPTY_STATE);
  const [error, setError] = useState<string | null>(null);
  const [isGenerating, startGenerate] = useTransition();
  const [isInjecting, startInject] = useTransition();

  function handleGenerate() {
    setError(null);
    startGenerate(async () => {
      const result = await generateBriefDraft(hint);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const { brief } = result;
      setFields({
        niche: brief.niche,
        style_keywords: brief.style_keywords.join(", "),
        top_tags: brief.top_tags.join(", "),
        color_palette: brief.color_palette.join(", "),
        price_target_usd: brief.price_target_usd.toFixed(2),
      });
    });
  }

  function handleInject(formData: FormData) {
    setError(null);
    startInject(async () => {
      try {
        await injectBrief(formData);
        setFields(EMPTY_STATE);
        setHint("");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  const busy = isGenerating || isInjecting;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 rounded-(--radius-sm) border border-dashed border-(--surface-line) bg-(--surface-1) p-3">
        <label className="flex flex-col gap-1.5 text-xs uppercase tracking-wider text-(--text-muted)">
          Hint (optional)
          <input
            value={hint}
            onChange={(e) => setHint(e.target.value)}
            disabled={busy}
            placeholder="trail running, Q2 gift niches, axe throwing…"
            maxLength={200}
            className="h-9 rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-2) px-3 text-sm text-(--text-primary) normal-case tracking-normal focus:border-(--accent-warm) focus:outline-none disabled:opacity-50"
          />
        </label>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-(--text-muted)">
            Asks Claude to draft a full niche. Edit fields below before injecting.
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleGenerate}
            disabled={busy}
          >
            {isGenerating ? "Generating…" : "Generate niche"}
          </Button>
        </div>
      </div>

      <form action={handleInject} className="flex flex-col gap-3">
        <Field
          label="Niche"
          name="niche"
          required
          placeholder="dark fantasy mushrooms"
          value={fields.niche}
          onChange={(v) => setFields((f) => ({ ...f, niche: v }))}
          disabled={busy}
        />
        <Field
          label="Style keywords (comma-separated)"
          name="style_keywords"
          placeholder="botanical, earthy, hand-drawn"
          value={fields.style_keywords}
          onChange={(v) => setFields((f) => ({ ...f, style_keywords: v }))}
          disabled={busy}
        />
        <Field
          label="Tags (max 13, comma-separated)"
          name="top_tags"
          placeholder="dark fantasy, mushroom tee, fairycore"
          value={fields.top_tags}
          onChange={(v) => setFields((f) => ({ ...f, top_tags: v }))}
          disabled={busy}
        />
        <Field
          label="Color palette (comma-separated hex/CSS colors)"
          name="color_palette"
          placeholder="#5a7d6a, #c0a06b, #e6d3b3"
          value={fields.color_palette}
          onChange={(v) => setFields((f) => ({ ...f, color_palette: v }))}
          disabled={busy}
        />
        <Field
          label="Price target USD"
          name="price_target_usd"
          type="number"
          step="0.01"
          placeholder="24.99"
          value={fields.price_target_usd}
          onChange={(v) => setFields((f) => ({ ...f, price_target_usd: v }))}
          disabled={busy}
        />
        {error && (
          <span className="text-xs text-(--accent-bad)">{error}</span>
        )}
        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={busy}>
            {isInjecting ? "Injecting…" : "Inject brief"}
          </Button>
        </div>
      </form>
    </div>
  );
}

interface FieldProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> {
  label: string;
  value: string;
  onChange: (value: string) => void;
}

function Field({ label, value, onChange, ...rest }: FieldProps) {
  return (
    <label className="flex flex-col gap-1.5 text-xs uppercase tracking-wider text-(--text-muted)">
      {label}
      <input
        {...rest}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) px-3 text-sm text-(--text-primary) normal-case tracking-normal focus:border-(--accent-warm) focus:outline-none disabled:opacity-50"
      />
    </label>
  );
}

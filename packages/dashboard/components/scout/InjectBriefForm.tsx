import { injectBrief } from "@/lib/actions/scout";
import { Button } from "@/components/ui/Button";

export function InjectBriefForm() {
  return (
    <form action={injectBrief} className="flex flex-col gap-3">
      <Field label="Niche" name="niche" required placeholder="dark fantasy" />
      <Field
        label="Style keywords (comma-separated)"
        name="style_keywords"
        placeholder="botanical, earthy, hand-drawn"
      />
      <Field
        label="Tags (max 13, comma-separated)"
        name="top_tags"
        placeholder="dark fantasy, mushroom tee, fairycore"
      />
      <Field
        label="Color palette (comma-separated hex/CSS colors)"
        name="color_palette"
        placeholder="#5a7d6a, #c0a06b, #e6d3b3"
      />
      <Field
        label="Price target USD"
        name="price_target_usd"
        type="number"
        step="0.01"
        placeholder="24.99"
      />
      <div className="flex justify-end">
        <Button type="submit" variant="primary">Inject brief</Button>
      </div>
    </form>
  );
}

function Field(props: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const { label, ...rest } = props;
  return (
    <label className="flex flex-col gap-1.5 text-xs uppercase tracking-wider text-(--text-muted)">
      {label}
      <input
        {...rest}
        className="h-9 rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) px-3 text-sm text-(--text-primary) focus:border-(--accent-warm) focus:outline-none"
      />
    </label>
  );
}

import { Button } from "@/components/ui/Button";
import { ConfirmDelete } from "@/components/ui/ConfirmDelete";
import { StatusBadge } from "@/components/status/StatusBadge";
import { formatRelative, formatUsd } from "@/lib/format";
import { approveBrief, deleteBrief, regenerateBrief } from "@/lib/actions/scout";
import type { TrendBriefRow } from "@/lib/queries/types";

interface BriefReviewCardProps {
  brief: TrendBriefRow & {
    raw_etsy_data?: unknown;
    claude_analysis?: unknown;
  };
}

interface EtsyListing {
  url?: string;
  url_570xN?: string;
  url_fullxfull?: string;
  title?: string;
}

function thumbnailUrls(raw: unknown): { src: string; title: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 5)
    .map((it) => {
      const x = (it ?? {}) as EtsyListing;
      const src = x.url_570xN ?? x.url_fullxfull ?? x.url ?? "";
      return { src, title: x.title ?? "" };
    })
    .filter((x) => x.src.length > 0);
}

export function BriefReviewCard({ brief: b }: BriefReviewCardProps) {
  const thumbs = thumbnailUrls(b.raw_etsy_data);

  return (
    <article className="rounded-(--radius-lg) border border-(--surface-line) bg-(--surface-1) p-5">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-xl font-semibold text-(--text-primary)">
            {b.niche}
          </h3>
          <p className="mt-1 text-xs text-(--text-muted)">
            <span suppressHydrationWarning>{formatRelative(b.created_at)}</span>
            {b.price_target_usd != null && ` · ${formatUsd(b.price_target_usd)} target`}
          </p>
        </div>
        <StatusBadge status={b.status} />
      </header>

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        {b.style_keywords && b.style_keywords.length > 0 && (
          <Section title="Style keywords">
            <Chips items={b.style_keywords} />
          </Section>
        )}
        {b.top_tags && b.top_tags.length > 0 && (
          <Section title="Top tags">
            <Chips items={b.top_tags} />
          </Section>
        )}
        {b.color_palette && b.color_palette.length > 0 && (
          <Section title="Palette">
            <div className="flex flex-wrap gap-1.5">
              {b.color_palette.slice(0, 10).map((c, i) => (
                <span
                  key={`${c}-${i}`}
                  title={c}
                  aria-label={`Color ${c}`}
                  className="h-5 w-5 rounded-full border border-(--surface-line)"
                  style={{ background: c }}
                />
              ))}
            </div>
          </Section>
        )}
      </div>

      {thumbs.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs uppercase tracking-wider text-(--text-muted) hover:text-(--text-primary)">
            Top trending listings ({thumbs.length})
          </summary>
          <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
            {thumbs.map((t, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={`${t.src}-${i}`}
                src={t.src}
                alt={t.title || "Trending listing"}
                title={t.title}
                loading="lazy"
                className="aspect-square h-28 shrink-0 rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) object-cover md:h-36"
              />
            ))}
          </div>
        </details>
      )}

      {b.prompt_constraint && (
        <div className="mt-4 rounded-(--radius-sm) border border-(--accent-warm)/30 bg-(--accent-warm)/5 px-3 py-2">
          <div className="text-[11px] uppercase tracking-wider text-(--accent-warm)">
            Prompt constraint
          </div>
          <p className="mt-1 whitespace-pre-wrap text-xs leading-snug text-(--text-primary)">
            {b.prompt_constraint}
          </p>
        </div>
      )}

      {b.claude_analysis != null && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs uppercase tracking-wider text-(--text-muted) hover:text-(--text-primary)">
            Claude analysis
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-(--radius-sm) bg-(--surface-2) p-3 text-[11px] leading-snug text-(--text-secondary)">
            {JSON.stringify(b.claude_analysis, null, 2)}
          </pre>
        </details>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <form action={approveBrief}>
          <input type="hidden" name="id" value={b.id} />
          <Button type="submit" variant="success">
            Approve
          </Button>
        </form>
        <form action={regenerateBrief}>
          <input type="hidden" name="id" value={b.id} />
          <Button type="submit" variant="secondary">
            Regen
          </Button>
        </form>
        <div className="ml-auto w-44">
          <ConfirmDelete
            action={deleteBrief}
            id={b.id}
            helper="Removes the brief. Refused if a design references it."
          />
        </div>
      </div>
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-(--text-muted)">{title}</div>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function Chips({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((it) => (
        <span
          key={it}
          className="rounded-(--radius-sm) bg-(--surface-2) px-2 py-0.5 text-xs text-(--text-secondary)"
        >
          {it}
        </span>
      ))}
    </div>
  );
}

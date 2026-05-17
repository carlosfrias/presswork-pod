"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Lightbox, ZoomButton } from "@/components/ui/Lightbox";
import { ReplaceImageForm } from "@/components/design/ReplaceImageForm";
import { formatRelative } from "@/lib/format";
import { withCacheBuster, withDownload, withTransform } from "@/lib/imageUrl";
import { cancelTouchUp } from "@/lib/actions/design";
import type { DesignReviewItem } from "@/lib/queries/design";

/**
 * Card for designs in 'touch_up' status. The operator downloads the masked
 * PNG, edits it externally, and re-uploads. On upload the design returns to
 * needs_review for a final approve pass before Listing claims it.
 *
 * "Cancel" sends the design back to needs_review without uploading — useful
 * when the operator flagged it by mistake or decided the AI output was fine.
 */
export function TouchUpCard({ design: d }: { design: DesignReviewItem }) {
  const [zoomOpen, setZoomOpen] = useState(false);
  const src = withCacheBuster(d.image_url, d.updated_at);
  const thumb = withCacheBuster(
    withTransform(d.image_url, { width: 560, height: 560, quality: 85, resize: "cover" }),
    d.updated_at,
  );

  return (
    <article className="rounded-(--radius-lg) border border-(--accent-warm)/30 bg-(--accent-warm)/5 p-5">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[200px_1fr]">
        <div className="flex flex-col gap-3">
          <div className="group relative aspect-square w-full overflow-hidden rounded-(--radius) border border-(--surface-line) bg-(--surface-2)">
            {src ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={thumb ?? src}
                  alt="Design awaiting touch-up"
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
                <ZoomButton
                  onClick={() => setZoomOpen(true)}
                  ariaLabel="Zoom into design"
                  className="absolute top-2 right-2"
                />
              </>
            ) : (
              <div className="flex h-full w-full items-center justify-center text-xs text-(--text-faint)">
                no image
              </div>
            )}
          </div>
          {src && (
            <Lightbox
              open={zoomOpen}
              onClose={() => setZoomOpen(false)}
              src={src}
              alt="Design awaiting touch-up"
              caption={d.id.slice(0, 8)}
            />
          )}
          <div className="text-xs text-(--text-muted)">
            <div>
              Niche:{" "}
              <span className="text-(--text-primary)">{d.trend_brief?.niche ?? "—"}</span>
            </div>
            <div className="font-mono">{d.id.slice(0, 8)}</div>
            <div suppressHydrationWarning>{formatRelative(d.created_at)}</div>
            {d.generation_cost_usd > 0 && (
              <div className="mt-1 font-medium tabular text-(--text-secondary)">
                ${d.generation_cost_usd.toFixed(3)} total
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <header>
            <h3 className="font-display text-lg font-semibold text-(--text-primary)">
              Touch-up needed
            </h3>
            <p className="mt-1 text-xs text-(--text-muted)">
              Download the masked PNG, edit locally, then re-upload. The design
              returns to the review queue after upload for a final approve pass.
            </p>
          </header>

          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-(--text-secondary)">1 · Download</p>
            <div className="flex flex-wrap gap-2">
              {d.image_url && (
                <a
                  href={withDownload(d.image_url, `design-${d.id.slice(0, 8)}-masked.png`) ?? d.image_url}
                  download={`design-${d.id.slice(0, 8)}-masked.png`}
                  className="rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) px-3 py-1.5 text-xs text-(--text-secondary) hover:border-(--accent-warm) hover:text-(--text-primary)"
                >
                  Download masked PNG
                </a>
              )}
              {d.image_url_unmasked && (
                <a
                  href={withDownload(d.image_url_unmasked, `design-${d.id.slice(0, 8)}-unmasked.png`) ?? d.image_url_unmasked}
                  download={`design-${d.id.slice(0, 8)}-unmasked.png`}
                  className="rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) px-3 py-1.5 text-xs text-(--text-secondary) hover:border-(--accent-warm) hover:text-(--text-primary)"
                >
                  Download unmasked PNG
                </a>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-(--text-secondary)">2 · Re-upload edited PNG</p>
            <div className="max-w-xs">
              <ReplaceImageForm id={d.id} />
            </div>
          </div>

          <div className="border-t border-(--surface-line) pt-3">
            <form action={cancelTouchUp}>
              <input type="hidden" name="id" value={d.id} />
              <Button type="submit" variant="ghost" size="sm">
                Cancel — back to review
              </Button>
            </form>
          </div>
        </div>
      </div>
    </article>
  );
}

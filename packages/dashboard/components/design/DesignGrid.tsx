import { StatusBadge } from "@/components/status/StatusBadge";
import { ConfirmDelete } from "@/components/ui/ConfirmDelete";
import { EmptyState } from "@/components/ui/EmptyState";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { DesignGridImage } from "@/components/design/DesignGridImage";
import { ReplaceImageForm } from "@/components/design/ReplaceImageForm";
import { formatRelative } from "@/lib/format";
import { withCacheBuster, withDownload, withTransform } from "@/lib/imageUrl";
import {
  deleteDesign,
  regenerateDesign,
  reopenDesign,
  retryDesign,
} from "@/lib/actions/design";
import type { DesignGridRow } from "@/lib/queries/design";

export function DesignGrid({ designs }: { designs: DesignGridRow[] }) {
  if (designs.length === 0) {
    return <EmptyState title="No designs yet" hint="Design polls every 15 minutes." />;
  }
  return (
    <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
      {designs.map((d) => (
        <li
          key={d.id}
          className="group overflow-hidden rounded-(--radius-lg) border border-(--surface-line) bg-(--surface-2)"
        >
          <div className="relative aspect-square w-full overflow-hidden bg-(--surface-1)">
            <DesignGridImage
              src={withCacheBuster(d.image_url, d.updated_at)}
              thumbSrc={withTransform(withCacheBuster(d.image_url, d.updated_at), { width: 400, height: 400, quality: 75, resize: "cover" })}
              shortId={d.id.slice(0, 8)}
            />
            {/* Only flag when mockups exist but the provenance bit wasn't flipped.
                Default-false on fresh designs is normal — Listing flips it when it
                creates the Printify product. */}
            {(d.mockup_urls?.length ?? 0) > 0 && !d.mockups_from_actual_design && (
              <span
                className="pointer-events-none absolute top-2 right-2 rounded-(--radius-sm) bg-(--accent-bad)/80 px-1.5 py-0.5 text-[10px] font-medium text-(--surface-0)"
                title="Mockups exist but mockups_from_actual_design is false — compliance rule #4 violation"
              >
                provenance!
              </span>
            )}
          </div>
          <div className="flex flex-col gap-2 p-3">
            <div className="flex items-center justify-between">
              <StatusBadge status={d.status} />
              <span className="text-xs text-(--text-muted) tabular" suppressHydrationWarning>
                {formatRelative(d.created_at)}
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs text-(--text-muted)">
              <span className="font-mono">{d.id.slice(0, 6)}</span>
              {d.printify_blueprint_id && <span>· bp {d.printify_blueprint_id}</span>}
              {d.mockup_urls?.length ? <span>· {d.mockup_urls.length} mockups</span> : null}
              {d.generation_cost_usd > 0 && (
                <span className="ml-auto tabular font-medium text-(--text-secondary)">
                  ${d.generation_cost_usd.toFixed(3)}
                </span>
              )}
            </div>
            {d.error_message && (
              <div className="line-clamp-2 rounded-(--radius-sm) bg-(--accent-bad)/10 p-2 text-xs text-(--accent-bad)">
                {d.error_message}
              </div>
            )}
            {d.fal_prompt && (
              <details className="text-xs">
                <summary className="cursor-pointer text-(--text-muted) hover:text-(--text-primary)">
                  Prompt
                </summary>
                <p className="mt-1.5 rounded-(--radius-sm) bg-(--surface-1) p-2 font-mono text-[11px] leading-snug text-(--text-secondary)">
                  {d.fal_prompt}
                </p>
              </details>
            )}
            <div className="flex gap-2">
              {d.status === "approved" ? (
                d.has_blocking_listing ? (
                  <div
                    className="flex-1"
                    title="A listing references this design. Reject the listing first, then reopen."
                  >
                    <button
                      type="button"
                      disabled
                      className="w-full cursor-not-allowed rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) px-3 py-1.5 text-sm text-(--text-faint) opacity-50"
                    >
                      Reopen
                    </button>
                  </div>
                ) : (
                /* Approved designs get Reopen instead of Regenerate. Reopen
                   flips the row back to needs_review with no agent spawn and
                   no clearing — the operator re-enters the review surface
                   with the full image stack intact, can browse versions and
                   tweak settings, and only pays for a fresh agent run if
                   they hit Regen there. */
                <form action={reopenDesign} className="flex-1">
                  <input type="hidden" name="id" value={d.id} />
                  <SubmitButton
                    size="sm"
                    variant="secondary"
                    className="w-full"
                    idleLabel="Reopen"
                    pendingLabel="Reopening…"
                  />
                </form>
                )
              ) : d.has_blocking_listing ? (
                <div
                  className="flex-1"
                  title="A listing is in progress — reject or complete the listing before regenerating."
                >
                  <button
                    type="button"
                    disabled
                    className="flex w-full cursor-not-allowed items-center justify-center gap-1.5 rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) px-3 py-1.5 text-sm text-(--text-faint) opacity-60"
                  >
                    <LockIcon />
                    Regenerate
                  </button>
                </div>
              ) : (
                <form action={regenerateDesign} className="flex-1">
                  <input type="hidden" name="id" value={d.id} />
                  <SubmitButton
                    size="sm"
                    variant="secondary"
                    className="w-full"
                    idleLabel="Regenerate"
                    pendingLabel="Regenerating…"
                  />
                </form>
              )}
              {d.status === "error" && (
                <form action={retryDesign} className="flex-1">
                  <input type="hidden" name="id" value={d.id} />
                  <SubmitButton
                    size="sm"
                    variant="ghost"
                    className="w-full"
                    idleLabel="Retry"
                    pendingLabel="Retrying…"
                  />
                </form>
              )}
            </div>
            {/* Hand-edit cycle: approved-only. Download buttons let the
                operator pull masked + unmasked PNGs locally for editing,
                then ReplaceImageForm re-injects the modified image back
                into the row (versioned in metadata.image_versions) and
                flips status to needs_review so the operator re-approves
                before Listing publishes. */}
            {d.status === "approved" && (
              <div className="flex flex-col gap-2 border-t border-(--surface-line) pt-2">
                <div className="flex flex-wrap gap-1.5 text-[11px]">
                  {d.image_url && (
                    <a
                      href={
                        withDownload(
                          d.image_url,
                          `design-${d.id.slice(0, 8)}-masked.png`,
                        ) ?? d.image_url
                      }
                      download={`design-${d.id.slice(0, 8)}-masked.png`}
                      className="rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) px-2 py-1 text-(--text-secondary) hover:border-(--accent-warm) hover:text-(--text-primary)"
                    >
                      Download masked
                    </a>
                  )}
                  {d.image_url_unmasked && (
                    <a
                      href={
                        withDownload(
                          d.image_url_unmasked,
                          `design-${d.id.slice(0, 8)}-unmasked.png`,
                        ) ?? d.image_url_unmasked
                      }
                      download={`design-${d.id.slice(0, 8)}-unmasked.png`}
                      className="rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-1) px-2 py-1 text-(--text-secondary) hover:border-(--accent-warm) hover:text-(--text-primary)"
                    >
                      Download unmasked
                    </a>
                  )}
                </div>
                <ReplaceImageForm id={d.id} />
              </div>
            )}
            <ConfirmDelete
              action={deleteDesign}
              id={d.id}
              helper="Really?"
              locked={d.has_blocking_listing}
              lockedTitle="A listing is in progress — reject or complete the listing before deleting."
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function LockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

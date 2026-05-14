"use client";

import { useEffect, useRef } from "react";

/**
 * Fullscreen image lightbox built on the native <dialog> element.
 *
 * Why <dialog> over a portal-based modal:
 *   - ESC-to-close, focus trap, and scroll lock are built in
 *   - `::backdrop` pseudo-element gives free backdrop styling
 *   - No portal plumbing, no z-index escalation arms race
 *
 * Behavior:
 *   - Click anywhere outside the image (on the dialog's padded backdrop area)
 *     closes the lightbox. Clicks on the image are captured by an inner
 *     wrapper so they don't bubble through and trigger close.
 *   - ESC closes (native).
 *   - X button in the corner closes.
 *   - Image is contained to 90vh / 90vw with object-contain — vertical and
 *     horizontal aspect ratios both fit cleanly.
 *
 * Consumer controls `open` state; we sync into the dialog element via
 * showModal() / close() and call `onClose` on any native close event so the
 * parent state stays consistent with the actual DOM state.
 */
interface Props {
  open: boolean;
  onClose: () => void;
  src: string;
  alt: string;
  caption?: string;
}

export function Lightbox({ open, onClose, src, alt, caption }: Props) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  // Sync external open state into the native dialog. Guard against
  // re-calling showModal on an already-open dialog (throws InvalidStateError).
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  function handleDialogClick(e: React.MouseEvent<HTMLDialogElement>) {
    // Native <dialog> reports itself as the click target when the user clicks
    // the backdrop area (the padded space around the content). Clicks on
    // children — including the image wrapper — report the child as the
    // target, so we only close on the literal backdrop hit.
    if (e.target === dialogRef.current) onClose();
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onCancel={onClose}
      onClick={handleDialogClick}
      // Reset the browser's default dialog chrome — we draw our own backdrop
      // and chrome through Tailwind classes + the ::backdrop selector below.
      // `m-auto` keeps the dialog centered when the OS-default position would
      // otherwise pin it to the top of the viewport.
      className="m-auto max-h-[100vh] max-w-[100vw] overflow-visible border-0 bg-transparent p-0 outline-none backdrop:bg-black/85 backdrop:backdrop-blur-sm"
    >
      <div className="relative">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close zoom view"
          className="absolute top-2 right-2 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-lg text-white hover:bg-black/80 focus:outline-none focus:ring-2 focus:ring-white/60"
        >
          ×
        </button>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          className="block max-h-[90vh] max-w-[90vw] rounded-(--radius-md) object-contain shadow-2xl"
        />
        {caption && (
          <div className="mt-2 text-center text-xs text-white/80">{caption}</div>
        )}
      </div>
    </dialog>
  );
}

/**
 * Small magnifying-glass icon button intended to overlay an image. Used as
 * the lightbox trigger in DesignReviewCard, where the underlying image
 * already has a click behavior (mask toggle) so we can't just wrap the
 * whole image in a button.
 */
interface ZoomButtonProps {
  onClick: () => void;
  className?: string;
  ariaLabel?: string;
}

export function ZoomButton({
  onClick,
  className = "",
  ariaLabel = "Zoom into image",
}: ZoomButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title="Zoom"
      className={`flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white shadow-lg backdrop-blur-sm transition-colors hover:bg-black/75 focus:outline-none focus:ring-2 focus:ring-white/60 ${className}`}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-4 w-4"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
        <path d="M11 8v6" />
        <path d="M8 11h6" />
      </svg>
    </button>
  );
}

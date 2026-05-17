"use client";

import { useState } from "react";
import { Lightbox } from "@/components/ui/Lightbox";

/**
 * Image cell for DesignGrid. The whole image is the lightbox trigger —
 * unlike DesignReviewCard there's no competing click behavior here, so a
 * full-image button is simpler than the icon-overlay pattern.
 *
 * Server-component parent (DesignGrid) renders the static surround; this
 * client subcomponent owns the lightbox open state.
 */
interface Props {
  src: string | null;
  thumbSrc?: string | null;
  shortId: string;
}

export function DesignGridImage({ src, thumbSrc, shortId }: Props) {
  const [zoomOpen, setZoomOpen] = useState(false);

  if (!src) {
    return (
      <div className="flex h-full w-full items-center justify-center text-xs text-(--text-faint)">
        no image
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setZoomOpen(true)}
        aria-label="Zoom into design"
        title="Click to zoom"
        className="block h-full w-full cursor-zoom-in focus:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-warm)"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={thumbSrc ?? src}
          alt="Design"
          className="h-full w-full object-contain transition-transform duration-300 group-hover:scale-[1.03]"
          loading="lazy"
        />
      </button>
      <Lightbox
        open={zoomOpen}
        onClose={() => setZoomOpen(false)}
        src={src}
        alt="Design"
        caption={shortId}
      />
    </>
  );
}

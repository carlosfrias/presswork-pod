"use client";

import { useState } from "react";
import { Lightbox } from "@/components/ui/Lightbox";
import { withTransform } from "@/lib/imageUrl";

interface MockupCarouselProps {
  imageUrl: string | null;
  mockupUrls: string[] | null;
  alt?: string;
}

export function MockupCarousel({ imageUrl, mockupUrls, alt = "Mockup" }: MockupCarouselProps) {
  const all = [imageUrl, ...(mockupUrls ?? [])].filter(
    (u): u is string => typeof u === "string" && u.length > 0,
  );
  const [zoomed, setZoomed] = useState<string | null>(null);

  if (all.length === 0) {
    return (
      <div className="flex aspect-square w-full items-center justify-center rounded-(--radius) border border-(--surface-line) bg-(--surface-2) text-xs text-(--text-faint)">
        no mockups
      </div>
    );
  }

  return (
    <>
      <div className="flex gap-2 overflow-x-auto pb-1" role="region" aria-label="Mockups">
        {all.map((src, i) => (
          <button
            key={`${src}-${i}`}
            type="button"
            onClick={() => setZoomed(src)}
            className="group relative shrink-0 cursor-zoom-in rounded-(--radius) border border-(--surface-line) bg-(--surface-1) focus:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-warm)"
            aria-label={`Zoom ${alt} ${i + 1}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={withTransform(src, { width: 200, height: 200, quality: 75, resize: "cover" }) ?? src}
              alt={`${alt} ${i + 1}`}
              loading="lazy"
              className="aspect-square h-32 rounded-(--radius) object-contain transition-opacity group-hover:opacity-80 md:h-40"
            />
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100"
            >
              <span className="rounded-full bg-(--surface-0)/75 p-1.5 backdrop-blur-sm">
                <MagIcon />
              </span>
            </span>
          </button>
        ))}
      </div>

      {zoomed && (
        <Lightbox
          open
          onClose={() => setZoomed(null)}
          src={zoomed}
          alt={alt}
          caption={`${all.indexOf(zoomed) + 1} of ${all.length}`}
        />
      )}
    </>
  );
}

function MagIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
      <path d="M11 8v6M8 11h6" />
    </svg>
  );
}

interface MockupCarouselProps {
  imageUrl: string | null;
  mockupUrls: string[] | null;
  alt?: string;
}

export function MockupCarousel({ imageUrl, mockupUrls, alt = "Mockup" }: MockupCarouselProps) {
  const all = [imageUrl, ...(mockupUrls ?? [])].filter(
    (u): u is string => typeof u === "string" && u.length > 0,
  );
  if (all.length === 0) {
    return (
      <div className="flex aspect-square w-full items-center justify-center rounded-(--radius) border border-(--surface-line) bg-(--surface-2) text-xs text-(--text-faint)">
        no mockups
      </div>
    );
  }
  return (
    <div className="flex gap-2 overflow-x-auto pb-1" role="region" aria-label="Mockups">
      {all.map((src, i) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={`${src}-${i}`}
          src={src}
          alt={`${alt} ${i + 1}`}
          loading="lazy"
          className="aspect-square h-32 shrink-0 rounded-(--radius) border border-(--surface-line) bg-(--surface-1) object-cover md:h-40"
        />
      ))}
    </div>
  );
}

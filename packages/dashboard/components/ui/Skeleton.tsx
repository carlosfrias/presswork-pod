import { cn } from "@/lib/cn";

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-(--radius-md) bg-(--surface-2)",
        className,
      )}
    />
  );
}

interface PageSkeletonProps {
  title: string;
  /** Number of stacked SurfaceCard placeholders to render below the header. */
  cards?: number;
}

export function PageSkeleton({ title, cards = 3 }: PageSkeletonProps) {
  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="font-display text-(length:--text-3xl) font-semibold">{title}</h1>
        <Skeleton className="mt-3 h-4 w-72" />
      </header>
      {Array.from({ length: cards }).map((_, i) => (
        <div
          key={i}
          className="rounded-(--radius-lg) border border-(--surface-line) bg-(--surface-1) p-5"
        >
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-2 h-3 w-60" />
          <Skeleton className="mt-5 h-24 w-full" />
        </div>
      ))}
    </div>
  );
}

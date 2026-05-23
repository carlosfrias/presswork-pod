import { Skeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="font-display text-(length:--text-3xl) font-semibold">Overview</h1>
        <Skeleton className="mt-3 h-4 w-72" />
      </header>

      {/* Two large KPI tiles */}
      <section className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Skeleton className="h-28 rounded-(--radius-lg)" />
        <Skeleton className="h-28 rounded-(--radius-lg)" />
      </section>

      {/* Six small KPI tiles */}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-(--radius-lg)" />
        ))}
      </section>

      {/* Spend chart + recent errors */}
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 rounded-(--radius-lg) border border-(--surface-line) bg-(--surface-1) p-5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="mt-2 h-3 w-40" />
          <Skeleton className="mt-5 h-48 w-full" />
        </div>
        <div className="rounded-(--radius-lg) border border-(--surface-line) bg-(--surface-1) p-5">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="mt-2 h-3 w-44" />
          <div className="mt-5 flex flex-col gap-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        </div>
      </section>

      {/* Pipeline health */}
      <section className="rounded-(--radius-lg) border border-(--surface-line) bg-(--surface-1) p-5">
        <Skeleton className="h-4 w-36" />
        <Skeleton className="mt-2 h-3 w-52" />
        <Skeleton className="mt-5 h-10 w-full" />
      </section>
    </div>
  );
}

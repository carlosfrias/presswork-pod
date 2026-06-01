import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { ErrorTriage } from "@/components/overview/ErrorTriage";
import { getAllErrors } from "@/lib/queries/overview";

export const revalidate = 30;

export default async function ErrorsPage() {
  const errors = await getAllErrors();

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="font-display text-(length:--text-3xl) font-semibold text-(--text-primary)">
          Error triage
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-(--text-muted)">
          Every errored row across the pipeline — requeue in one click.
        </p>
      </header>

      <SurfaceCard>
        <ErrorTriage errors={errors} />
      </SurfaceCard>
    </div>
  );
}

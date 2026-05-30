import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { KpiTile } from "@/components/ui/KpiTile";
import { SpendChart } from "@/components/overview/SpendChart";
import { PipelineHealthBar } from "@/components/overview/PipelineHealth";
import { RecentErrors } from "@/components/overview/RecentErrors";
import {
  getKpis,
  getDailySummary,
  getPipelineHealth,
  getRecentErrors,
} from "@/lib/queries/overview";
import { formatNumber, formatUsd } from "@/lib/format";

export const revalidate = 30;

export default async function OverviewPage() {
  const [kpis30, daily, health, errors] = await Promise.all([
    getKpis(30),
    getDailySummary(30),
    getPipelineHealth(),
    getRecentErrors(10),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="font-display text-(length:--text-3xl) font-semibold text-(--text-primary)">
          Overview
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-(--text-muted)">
          Last 30 days across the pipeline — revenue, spend, and where the queues are stuck.
        </p>
      </header>

      <section className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <KpiTile
          label="Revenue (30d)"
          value={formatUsd(kpis30.revenue_usd, { compact: true })}
          accent="warm"
          size="xl"
          hint={<span>{kpis30.order_count} orders</span>}
        />
        <KpiTile
          label="Margin (30d)"
          value={formatUsd(kpis30.margin_usd, { compact: true })}
          accent="good"
          size="xl"
          hint={
            kpis30.revenue_usd > 0 ? (
              <span>{((kpis30.margin_usd / kpis30.revenue_usd) * 100).toFixed(1)}% net</span>
            ) : undefined
          }
        />
      </section>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiTile
          label="Listings published"
          value={formatNumber(kpis30.listings_published)}
          size="md"
          accent="neutral"
        />
        <KpiTile
          label="Designs"
          value={formatNumber(kpis30.designs)}
          size="md"
          accent="neutral"
        />
        <KpiTile
          label="Briefs"
          value={formatNumber(kpis30.briefs)}
          size="md"
          accent="neutral"
        />
      </section>

      <section>
        <SurfaceCard title="Pipeline health" subtitle="In-flight + errors by agent">
          <PipelineHealthBar rows={health} />
        </SurfaceCard>
      </section>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <SurfaceCard
          className="lg:col-span-2"
          title="Daily margin"
          subtitle="Last 30 days"
        >
          <SpendChart data={daily} />
        </SurfaceCard>
        <SurfaceCard title="Recent errors" subtitle="Last 10 across all agents">
          <RecentErrors errors={errors} />
        </SurfaceCard>
      </section>
    </div>
  );
}

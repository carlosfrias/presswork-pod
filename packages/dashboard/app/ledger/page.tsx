import { Suspense } from "react";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { KpiTile } from "@/components/ui/KpiTile";
import { RevenueChart } from "@/components/ledger/RevenueChart";
import { MarginHistogram } from "@/components/ledger/MarginHistogram";
import { TopListingsTable } from "@/components/ledger/TopListingsTable";
import { BelowThresholdTable } from "@/components/ledger/BelowThresholdTable";
import { CurrencyDonut } from "@/components/ledger/CurrencyDonut";
import { FlagsRail } from "@/components/flags/FlagsRail";
import { AgentRunButton } from "@/components/triggers/AgentRunButton";
import { Skeleton } from "@/components/ui/Skeleton";
import {
  getLedgerKpis,
  getMarginDistribution,
  getTopListings,
  getCurrencyBreakdown,
  getBelowThresholdOrders,
} from "@/lib/queries/ledger";
import { getDailySummary, getRuntimeFlags } from "@/lib/queries/overview";
import { formatNumber, formatUsd } from "@/lib/format";

export const revalidate = 30;

async function RevenuePanel() {
  const daily = await getDailySummary(30);
  return <RevenueChart data={daily} />;
}

async function MarginPanel({ threshold }: { threshold: number }) {
  const margins = await getMarginDistribution(90);
  return <MarginHistogram buckets={margins} threshold={threshold} />;
}

async function TopListingsPanel() {
  const rows = await getTopListings(10, 30);
  return <TopListingsTable rows={rows} />;
}

async function CurrencyPanel() {
  const rows = await getCurrencyBreakdown(30);
  return <CurrencyDonut rows={rows} />;
}

async function BelowThresholdPanel({ threshold }: { threshold: number }) {
  const rows = await getBelowThresholdOrders(threshold, 25);
  return <BelowThresholdTable rows={rows} threshold={threshold} />;
}

export default async function LedgerPage() {
  // Header + KPI tiles depend only on flags + the 30d roll-up. Everything
  // else streams in via Suspense so the shell paints immediately.
  const [flags, kpi30] = await Promise.all([getRuntimeFlags(), getLedgerKpis(30)]);
  const thresholdRaw = flags.find((f) => f.key === "margin_warning_threshold_usd")?.value;
  const threshold = typeof thresholdRaw === "number" ? thresholdRaw : 5.0;

  const netPct = kpi30.revenue_usd > 0 ? (kpi30.margin_usd / kpi30.revenue_usd) * 100 : 0;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-(length:--text-3xl) font-semibold">Ledger</h1>
          <p className="mt-2 max-w-2xl text-sm text-(--text-muted)">
            Etsy receipts polled on demand. Margin is computed from sale price, Etsy fees,
            and best-effort print cost lookup.
          </p>
        </div>
        <AgentRunButton agent="ledger" />
      </header>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiTile
          label="Revenue (30d)"
          value={formatUsd(kpi30.revenue_usd, { compact: true })}
          accent="warm"
          size="xl"
        />
        <KpiTile
          label="Margin (30d)"
          value={formatUsd(kpi30.margin_usd, { compact: true })}
          accent="good"
          size="xl"
          hint={<span>{netPct.toFixed(1)}% net</span>}
        />
        <KpiTile label="Orders" value={formatNumber(kpi30.order_count)} accent="neutral" />
        <KpiTile
          label="Etsy fees"
          value={formatUsd(kpi30.etsy_fees_usd, { compact: true })}
          accent="warm"
        />
        <KpiTile
          label="Print cost"
          value={formatUsd(kpi30.print_cost_usd, { compact: true })}
          accent="cool"
          hint={
            kpi30.error_count > 0 ? (
              <span className="text-(--accent-bad)">{kpi30.error_count} errors</span>
            ) : undefined
          }
        />
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <SurfaceCard className="lg:col-span-2" title="Revenue waterfall" subtitle="Daily, last 30 days">
          <Suspense fallback={<Skeleton className="h-64 w-full" />}>
            <RevenuePanel />
          </Suspense>
        </SurfaceCard>
        <SurfaceCard title="Margin distribution" subtitle="Last 90 days">
          <Suspense fallback={<Skeleton className="h-64 w-full" />}>
            <MarginPanel threshold={threshold} />
          </Suspense>
        </SurfaceCard>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <SurfaceCard className="lg:col-span-2" title="Top earning listings" subtitle="Last 30 days">
          <Suspense fallback={<Skeleton className="h-48 w-full" />}>
            <TopListingsPanel />
          </Suspense>
        </SurfaceCard>
        <div className="flex flex-col gap-6">
          <SurfaceCard title="Currency mix" subtitle="Last 30 days">
            <Suspense fallback={<Skeleton className="h-48 w-full" />}>
              <CurrencyPanel />
            </Suspense>
          </SurfaceCard>
          <FlagsRail keys={["margin_warning_threshold_usd"]} title="Ledger flags" />
        </div>
      </div>

      <SurfaceCard
        title={`Below threshold (< ${formatUsd(threshold)})`}
        subtitle="Lowest-margin orders first"
      >
        <Suspense fallback={<Skeleton className="h-32 w-full" />}>
          <BelowThresholdPanel threshold={threshold} />
        </Suspense>
      </SurfaceCard>
    </div>
  );
}

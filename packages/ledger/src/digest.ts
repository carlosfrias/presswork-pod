import { type Db, getLogger, notifyEmail, notifySlack } from "@presswork/shared";

export interface DigestWindow {
  // ISO timestamps (inclusive start, exclusive end)
  start: string;
  end: string;
}

export interface DigestSummary {
  window: DigestWindow;
  orderCount: number;
  revenueUsd: number;
  feesUsd: number;
  printCostUsd: number;
  marginUsd: number;
  errored: number;
}

export async function runDailyDigest(
  db: Db,
  window: DigestWindow = defaultYesterdayWindow()
): Promise<DigestSummary> {
  const log = getLogger("ledger");
  const summary = await summarise(db, window);

  const message = formatSlackDigest(summary);
  await notifySlack(message, { severity: summary.errored > 0 ? "warn" : "info" });
  await notifyEmail(`Presswork daily digest — ${window.start.slice(0, 10)}`, formatEmailDigest(summary));

  log.info({ agent: "ledger", action: "daily_digest", ...summary });
  return summary;
}

async function summarise(db: Db, window: DigestWindow): Promise<DigestSummary> {
  const { data, error } = await db
    .from("orders")
    .select("status, sale_price_usd, etsy_fees_usd, print_cost_usd, margin_usd")
    .gte("created_at", window.start)
    .lt("created_at", window.end);

  if (error) {
    throw new Error(`digest query failed: ${error.message}`);
  }

  const rows = (data ?? []) as Array<{
    status: string;
    sale_price_usd: number | null;
    etsy_fees_usd: number | null;
    print_cost_usd: number | null;
    margin_usd: number | null;
  }>;

  let revenueUsd = 0;
  let feesUsd = 0;
  let printCostUsd = 0;
  let marginUsd = 0;
  let errored = 0;

  for (const row of rows) {
    if (row.status === "error") errored++;
    revenueUsd += row.sale_price_usd ?? 0;
    feesUsd += row.etsy_fees_usd ?? 0;
    printCostUsd += row.print_cost_usd ?? 0;
    marginUsd += row.margin_usd ?? 0;
  }

  return {
    window,
    orderCount: rows.length,
    revenueUsd,
    feesUsd,
    printCostUsd,
    marginUsd,
    errored,
  };
}

function formatSlackDigest(s: DigestSummary): string {
  const dateLabel = s.window.start.slice(0, 10);
  const errorLine = s.errored > 0 ? `\n• Errored rows: ${s.errored}` : "";
  return (
    `Presswork daily digest — ${dateLabel}\n` +
    `• Orders logged: ${s.orderCount}\n` +
    `• Revenue: $${s.revenueUsd.toFixed(2)}\n` +
    `• Etsy fees: $${s.feesUsd.toFixed(2)}\n` +
    `• Print cost: $${s.printCostUsd.toFixed(2)}\n` +
    `• Margin: $${s.marginUsd.toFixed(2)}` +
    errorLine
  );
}

function formatEmailDigest(s: DigestSummary): string {
  return [
    `Window: ${s.window.start} → ${s.window.end}`,
    `Orders logged: ${s.orderCount}`,
    `Revenue (USD): $${s.revenueUsd.toFixed(2)}`,
    `Etsy fees (USD): $${s.feesUsd.toFixed(2)}`,
    `Print cost (USD): $${s.printCostUsd.toFixed(2)}`,
    `Margin (USD): $${s.marginUsd.toFixed(2)}`,
    `Errored rows: ${s.errored}`,
  ].join("\n");
}

function defaultYesterdayWindow(): DigestWindow {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

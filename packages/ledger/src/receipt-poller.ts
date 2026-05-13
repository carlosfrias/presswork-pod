import {
  type Db,
  type EtsyReceipt,
  getLogger,
  listReceipts,
  notifySlack,
} from "@presswork/shared";
import {
  computeEtsyFees,
  lookupPrintCost,
  normalizeToUsd,
  UnknownBlueprintError,
  UnknownCurrencyError,
} from "./economics.js";
import {
  MARGIN_WARNING_THRESHOLD_USD,
  RECEIPT_POLL_PAGE_LIMIT,
} from "./constants.js";

export interface PollReceiptsResult {
  scanned: number;
  logged: number;
  duplicate: number;
  errored: number;
}

export async function pollReceipts(db: Db): Promise<PollReceiptsResult> {
  const log = getLogger("ledger");
  const result: PollReceiptsResult = { scanned: 0, logged: 0, duplicate: 0, errored: 0 };

  // Poll all paid receipts. We don't filter on was_shipped — Etsy↔Printify
  // handles fulfillment, so we want every paid order in our metrics. The
  // unique constraint on orders.etsy_order_id gives us free dedup, so
  // re-scanning the same window every cron tick is safe and cheap.
  const receipts = await listReceipts(db, {
    was_paid: true,
    limit: RECEIPT_POLL_PAGE_LIMIT,
  });
  result.scanned = receipts.length;

  for (const receipt of receipts) {
    try {
      const outcome = await logReceipt(db, receipt);
      if (outcome === "duplicate") {
        result.duplicate++;
      } else if (outcome === "error") {
        result.errored++;
      } else {
        result.logged++;
      }
    } catch (err) {
      result.errored++;
      log.error({
        agent: "ledger",
        action: "receipt_poll_item_error",
        receipt_id: receipt.receipt_id,
        error: String(err),
      });
    }
  }

  log.info({ agent: "ledger", action: "receipt_poll_done", ...result });
  return result;
}

type LogReceiptOutcome = "logged" | "duplicate" | "error";

async function logReceipt(db: Db, receipt: EtsyReceipt): Promise<LogReceiptOutcome> {
  const log = getLogger("ledger");
  const etsyReceiptId = String(receipt.receipt_id);
  const t0 = Date.now();

  // Buyer-paid amount stays in buyer currency on sale_price; sale_price_usd is
  // the normalized value used by reporting. Currency conversion is approximate
  // — exact economics belong to Etsy's payout API.
  const salePrice = receipt.grandtotal.amount / receipt.grandtotal.divisor;
  const currencyCode = receipt.grandtotal.currency_code;

  let salePriceUsd: number;
  try {
    salePriceUsd = normalizeToUsd(salePrice, currencyCode);
  } catch (err) {
    if (err instanceof UnknownCurrencyError) {
      await notifySlack(
        `Ledger: unknown currency "${currencyCode}" on receipt ${etsyReceiptId} — order logged with NULL economics`,
        { severity: "warn" }
      );
      return await insertOrderRow(db, etsyReceiptId, {
        sale_price: salePrice,
        currency_code: currencyCode,
        buyer_country: receipt.country_iso,
      });
    }
    throw err;
  }

  const etsyFeesUsd = computeEtsyFees(salePriceUsd);
  const printCostUsd = await resolvePrintCost(db, receipt);

  const outcome = await insertOrderRow(db, etsyReceiptId, {
    sale_price: salePrice,
    sale_price_usd: salePriceUsd,
    currency_code: currencyCode,
    etsy_fees_usd: etsyFeesUsd,
    print_cost_usd: printCostUsd,
    buyer_country: receipt.country_iso,
  });

  if (outcome === "logged" && printCostUsd !== null) {
    const margin = salePriceUsd - printCostUsd - etsyFeesUsd;
    if (margin < MARGIN_WARNING_THRESHOLD_USD) {
      await notifySlack(
        `Low margin: receipt ${etsyReceiptId} margin $${margin.toFixed(2)} ` +
          `(sale $${salePriceUsd.toFixed(2)} USD, print $${printCostUsd.toFixed(2)}, fees $${etsyFeesUsd.toFixed(2)})`,
        { severity: "warn" }
      );
    }
  }

  log.info({
    agent: "ledger",
    action: "log_receipt",
    record_id: etsyReceiptId,
    status: outcome,
    duration_ms: Date.now() - t0,
  });
  return outcome;
}

interface OrderEconomics {
  sale_price: number;
  sale_price_usd?: number;
  currency_code: string;
  etsy_fees_usd?: number;
  print_cost_usd?: number | null;
  buyer_country: string;
}

async function insertOrderRow(
  db: Db,
  etsyReceiptId: string,
  econ: OrderEconomics
): Promise<LogReceiptOutcome> {
  const log = getLogger("ledger");

  const { error: insertErr } = await db
    .from("orders")
    .insert({
      etsy_order_id: etsyReceiptId,
      status: "logged",
      ...econ,
    });

  if (insertErr) {
    if ((insertErr as { code?: string }).code === "23505") {
      return "duplicate";
    }
    log.error({
      agent: "ledger",
      action: "insert_order",
      record_id: etsyReceiptId,
      error: insertErr.message,
    });
    return "error";
  }
  return "logged";
}

// Best-effort: find the listing → design_package the receipt's first line item
// refers to, then look up the flat print cost for its blueprint. If the listing
// wasn't created by the Listing Agent (manual Etsy listing, pre-existing
// inventory), we still log the order — print_cost_usd just stays NULL.
async function resolvePrintCost(db: Db, receipt: EtsyReceipt): Promise<number | null> {
  const log = getLogger("ledger");
  const firstItem = receipt.transactions[0];
  if (!firstItem) return null;

  const { data: listingRow } = await db
    .from("listings")
    .select("design_package_id")
    .eq("etsy_listing_id", firstItem.listing_id)
    .maybeSingle();

  const listing = listingRow as { design_package_id: string } | null;
  if (!listing) {
    log.warn({
      agent: "ledger",
      action: "resolve_print_cost_no_listing",
      etsy_listing_id: firstItem.listing_id,
    });
    return null;
  }

  const { data: designRow } = await db
    .from("design_packages")
    .select("printify_blueprint_id")
    .eq("id", listing.design_package_id)
    .maybeSingle();

  const design = designRow as { printify_blueprint_id: number } | null;
  if (!design) return null;

  try {
    return lookupPrintCost(design.printify_blueprint_id);
  } catch (err) {
    if (err instanceof UnknownBlueprintError) {
      log.warn({
        agent: "ledger",
        action: "resolve_print_cost_unknown_blueprint",
        blueprint_id: design.printify_blueprint_id,
      });
      return null;
    }
    throw err;
  }
}

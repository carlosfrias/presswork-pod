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
  lookupShippingCost,
  normalizeToUsd,
  UnknownBlueprintError,
  UnknownCurrencyError,
} from "./economics.js";
import {
  MARGIN_WARNING_THRESHOLD_USD,
  RECEIPT_POLL_MAX_PAGES,
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
  // re-scanning the same window every run is safe and cheap.
  //
  // Page through with increasing offset until the queue is drained. Runs are
  // manual today, so a >100-receipt backlog between runs is realistic; a single
  // page would silently drop the oldest orders forever (M3). The short-page stop
  // is the correctness guarantee (with the RECEIPT_POLL_MAX_PAGES ceiling); the
  // all-duplicate-page early-exit below is a cheap optimization that relies on
  // Etsy's documented most-recent-first ordering.
  for (let page = 0; page < RECEIPT_POLL_MAX_PAGES; page++) {
    const offset = page * RECEIPT_POLL_PAGE_LIMIT;
    const receipts = await listReceipts(db, {
      was_paid: true,
      limit: RECEIPT_POLL_PAGE_LIMIT,
      offset,
    });
    result.scanned += receipts.length;

    let pageDuplicates = 0;
    for (const receipt of receipts) {
      try {
        const outcome = await logReceipt(db, receipt);
        if (outcome === "duplicate") {
          result.duplicate++;
          pageDuplicates++;
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

    log.info({
      agent: "ledger",
      action: "receipt_poll_page",
      page,
      offset,
      page_size: receipts.length,
    });

    // Last page reached — fewer than a full page means there's nothing beyond.
    if (receipts.length < RECEIPT_POLL_PAGE_LIMIT) break;

    // Early-exit: an entire page we've already logged means we've caught up to
    // previously-seen orders. Safe because Etsy returns receipts newest-first,
    // so everything past this page is older and already logged too.
    if (pageDuplicates === receipts.length) {
      log.info({ agent: "ledger", action: "receipt_poll_caught_up", page, offset });
      break;
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
  const { printCostUsd, shippingCostUsd } = await resolveCosts(db, receipt);

  const outcome = await insertOrderRow(db, etsyReceiptId, {
    sale_price: salePrice,
    sale_price_usd: salePriceUsd,
    currency_code: currencyCode,
    etsy_fees_usd: etsyFeesUsd,
    print_cost_usd: printCostUsd,
    shipping_cost_usd: shippingCostUsd,
    buyer_country: receipt.country_iso,
  });

  if (outcome === "logged" && printCostUsd !== null) {
    // Shipping is a real cost we absorb (Printify bills it on fulfillment), so
    // include it in the margin we warn on.
    const margin =
      salePriceUsd - printCostUsd - (shippingCostUsd ?? 0) - etsyFeesUsd;
    if (margin < MARGIN_WARNING_THRESHOLD_USD) {
      await notifySlack(
        `Low margin: receipt ${etsyReceiptId} margin $${margin.toFixed(2)} ` +
          `(sale $${salePriceUsd.toFixed(2)} USD, print $${printCostUsd.toFixed(2)}, ` +
          `shipping $${(shippingCostUsd ?? 0).toFixed(2)}, fees $${etsyFeesUsd.toFixed(2)})`,
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
  shipping_cost_usd?: number | null;
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

interface ResolvedCosts {
  printCostUsd: number | null;
  shippingCostUsd: number | null;
}

// Best-effort: find the listing → design_package the receipt's first line item
// refers to, then look up the flat print + shipping costs for its blueprint. If
// the listing wasn't created by the Listing Agent (manual Etsy listing,
// pre-existing inventory), we still log the order — the costs just stay NULL.
async function resolveCosts(db: Db, receipt: EtsyReceipt): Promise<ResolvedCosts> {
  const log = getLogger("ledger");
  const none: ResolvedCosts = { printCostUsd: null, shippingCostUsd: null };
  const firstItem = receipt.transactions[0];
  if (!firstItem) return none;

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
    return none;
  }

  const { data: designRow } = await db
    .from("design_packages")
    .select("printify_blueprint_id")
    .eq("id", listing.design_package_id)
    .maybeSingle();

  const design = designRow as { printify_blueprint_id: number } | null;
  if (!design) return none;

  try {
    return {
      printCostUsd: lookupPrintCost(design.printify_blueprint_id),
      shippingCostUsd: lookupShippingCost(design.printify_blueprint_id),
    };
  } catch (err) {
    if (err instanceof UnknownBlueprintError) {
      log.warn({
        agent: "ledger",
        action: "resolve_print_cost_unknown_blueprint",
        blueprint_id: design.printify_blueprint_id,
      });
      return none;
    }
    throw err;
  }
}

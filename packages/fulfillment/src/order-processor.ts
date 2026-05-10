import { type Db, getLogger, getSettings, notifySlack } from "@presswork/shared";
import * as etsyApi from "@presswork/shared";
import { createOrder } from "./printify-orders.js";
import { computeEtsyFees, lookupPrintCost } from "./economics.js";
import { MAX_RETRIES } from "./constants.js";

export type ProcessOrderOutcome = "created" | "duplicate" | "error";

export interface ProcessOrderResult {
  orderId?: string;
  outcome: ProcessOrderOutcome;
  error?: string;
}

export async function processOrder(
  db: Db,
  etsyReceiptId: string
): Promise<ProcessOrderResult> {
  const log = getLogger("fulfillment");
  const { ETSY_SHOP_ID: _shopId } = getSettings();
  const t0 = Date.now();

  // Step 1: idempotency-safe insert — if order already exists, returns nothing
  const { data: insertedRows, error: insertErr } = await db
    .from("orders")
    .insert({ etsy_order_id: etsyReceiptId, status: "received" })
    .select("id")
    .returns<Array<{ id: string }>>();

  if (insertErr) {
    // Postgres unique violation = code 23505
    const isUniqueViolation =
      (insertErr as { code?: string }).code === "23505" ||
      insertErr.message.includes("duplicate key");
    if (isUniqueViolation) {
      log.info({ agent: "fulfillment", action: "process_order", record_id: etsyReceiptId, status: "duplicate", duration_ms: Date.now() - t0 });
      return { outcome: "duplicate" };
    }
    return { outcome: "error", error: insertErr.message };
  }

  const orderId = insertedRows?.[0]?.id;
  if (!orderId) {
    log.info({ agent: "fulfillment", action: "process_order", record_id: etsyReceiptId, status: "duplicate", duration_ms: Date.now() - t0 });
    return { outcome: "duplicate" };
  }

  try {
    // Step 2: fetch canonical receipt from Etsy
    log.info({ agent: "fulfillment", action: "fetch_receipt", record_id: orderId, status: "started" });
    const receipt = await etsyApi.getReceipt(db, etsyReceiptId);

    const salePriceUsd =
      receipt.grandtotal.amount / receipt.grandtotal.divisor;

    // Step 3: resolve listing → design_package for the first line item
    const firstItem = receipt.transactions[0];
    if (!firstItem) {
      throw new Error("Receipt has no line items");
    }

    const { data: listingRow, error: listingErr } = await db
      .from("listings")
      .select("id, design_package_id")
      .eq("etsy_listing_id", firstItem.listing_id)
      .maybeSingle();

    if (listingErr || !listingRow) {
      const msg = `Listing ${firstItem.listing_id} not found in DB — manual intervention required`;
      await db
        .from("orders")
        .update({ status: "error", error_message: msg })
        .eq("id", orderId);
      await notifySlack(`Fulfillment error: ${msg}`, { severity: "error" });
      log.error({ agent: "fulfillment", action: "resolve_listing", record_id: orderId, status: "error", duration_ms: Date.now() - t0, error: msg });
      return { orderId, outcome: "error", error: msg };
    }

    const { data: designRow, error: designErr } = await db
      .from("design_packages")
      .select("image_url, printify_blueprint_id, printify_variant_ids")
      .eq("id", (listingRow as { id: string; design_package_id: string }).design_package_id)
      .single();

    if (designErr || !designRow) {
      const msg = `DesignPackage for listing ${firstItem.listing_id} not found`;
      await db
        .from("orders")
        .update({ status: "error", error_message: msg })
        .eq("id", orderId);
      await notifySlack(`Fulfillment error: ${msg}`, { severity: "error" });
      return { orderId, outcome: "error", error: msg };
    }

    const design = designRow as {
      image_url: string;
      printify_blueprint_id: number;
      printify_variant_ids: number[];
    };

    // Step 4: compute economics
    const etsyFeesUsd = computeEtsyFees(salePriceUsd);
    const printCostUsd = lookupPrintCost(design.printify_blueprint_id);

    await db
      .from("orders")
      .update({
        listing_id: (listingRow as { id: string }).id,
        sale_price_usd: salePriceUsd,
        etsy_fees_usd: etsyFeesUsd,
        print_cost_usd: printCostUsd,
        buyer_country: receipt.country_iso,
      })
      .eq("id", orderId);

    // Step 5: create Printify order
    log.info({ agent: "fulfillment", action: "create_printify_order", record_id: orderId, status: "started" });
    const { printifyOrderId } = await createOrder({
      etsyReceiptId,
      lineItems: receipt.transactions.map((t) => ({
        blueprintId: design.printify_blueprint_id,
        variantId: (design.printify_variant_ids[0]) ?? 0,
        imageUrl: design.image_url,
        quantity: t.quantity,
      })),
      address: {
        firstName: receipt.name.split(" ")[0] ?? receipt.name,
        lastName: receipt.name.split(" ").slice(1).join(" ") || receipt.name,
        email: receipt.buyer_email ?? "",
        address1: receipt.first_line,
        ...(receipt.second_line ? { address2: receipt.second_line } : {}),
        city: receipt.city,
        state: receipt.state ?? "",
        country: receipt.country_iso,
        zip: receipt.zip,
      },
    });

    await db
      .from("orders")
      .update({ printify_order_id: printifyOrderId, status: "submitted" })
      .eq("id", orderId);

    log.info({ agent: "fulfillment", action: "process_order", record_id: orderId, status: "submitted", duration_ms: Date.now() - t0 });
    return { orderId, outcome: "created" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    const { data: current } = await db
      .from("orders")
      .select("retry_count")
      .eq("id", orderId)
      .single();
    const retryCount = ((current as { retry_count?: number } | null)?.retry_count ?? 0) + 1;

    if (retryCount < MAX_RETRIES) {
      await db
        .from("orders")
        .update({ status: "received", error_message: message, retry_count: retryCount })
        .eq("id", orderId);
    } else {
      await db
        .from("orders")
        .update({ status: "error", error_message: message, retry_count: retryCount })
        .eq("id", orderId);
      await notifySlack(
        `Fulfillment order ${orderId} failed after ${retryCount} attempts: ${message}`,
        { severity: "error" }
      );
    }

    log.error({ agent: "fulfillment", action: "process_order", record_id: orderId, status: "error", duration_ms: Date.now() - t0, error: message });
    return { orderId, outcome: "error", error: message };
  }
}

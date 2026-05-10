import { type Db, getLogger, submitTracking, notifySlack } from "@presswork/shared";
import { getOrder } from "./printify-orders.js";
import { MAX_RETRIES } from "./constants.js";

export interface PollTrackingResult {
  scanned: number;
  shipped: number;
  stillInProgress: number;
  errored: number;
}

const SHIPPED_STATUSES = new Set(["fulfilled", "shipped"]);
const FAILED_STATUSES = new Set(["cancelled", "failed", "canceled"]);

export async function pollTracking(db: Db): Promise<PollTrackingResult> {
  const log = getLogger("fulfillment");
  const result: PollTrackingResult = { scanned: 0, shipped: 0, stillInProgress: 0, errored: 0 };

  const { data: rows, error } = await db
    .from("orders")
    .select("id, printify_order_id, etsy_order_id, retry_count")
    .eq("status", "submitted")
    .not("printify_order_id", "is", null);

  if (error) {
    log.error({ agent: "fulfillment", action: "tracking_poll_db_error", error: error.message });
    return result;
  }

  const orders = (rows ?? []) as Array<{
    id: string;
    printify_order_id: string;
    etsy_order_id: string;
    retry_count: number;
  }>;

  result.scanned = orders.length;

  for (const order of orders) {
    try {
      const detail = await getOrder(order.printify_order_id);

      if (SHIPPED_STATUSES.has(detail.status) && detail.tracking) {
        // Write tracking to DB
        await db
          .from("orders")
          .update({
            tracking_number: detail.tracking.number,
            tracking_url: detail.tracking.url,
            status: "shipped",
          })
          .eq("id", order.id);

        // Post tracking back to Etsy
        await submitTracking(db, order.etsy_order_id, {
          tracking_code: detail.tracking.number,
          carrier_name: detail.tracking.carrier,
        });

        log.info({
          agent: "fulfillment",
          action: "order_shipped",
          record_id: order.id,
          tracking: detail.tracking.number,
        });
        result.shipped++;
      } else if (FAILED_STATUSES.has(detail.status)) {
        const msg = `Printify order ${order.printify_order_id} status: ${detail.status}`;
        await db
          .from("orders")
          .update({ status: "error", error_message: msg })
          .eq("id", order.id);
        await notifySlack(msg, { severity: "error" });
        result.errored++;
      } else {
        result.stillInProgress++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryCount = (order.retry_count ?? 0) + 1;

      await db
        .from("orders")
        .update({ error_message: message, retry_count: retryCount })
        .eq("id", order.id);

      if (retryCount >= MAX_RETRIES) {
        await notifySlack(
          `Tracking poller: order ${order.id} failed ${retryCount} times: ${message}`,
          { severity: "error" }
        );
      }

      log.error({
        agent: "fulfillment",
        action: "tracking_poll_item_error",
        record_id: order.id,
        error: message,
      });
      result.errored++;
    }
  }

  log.info({ agent: "fulfillment", action: "tracking_poll_done", ...result });
  return result;
}

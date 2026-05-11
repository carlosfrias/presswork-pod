import { type Db, getLogger, submitTracking, notifySlack, normalizeEtsyCarrierName } from "@presswork/shared";
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

  // Pick up two distinct cases:
  //   (a) status='submitted' — normal "is it shipped yet?" poll.
  //   (b) status='shipped' AND etsy_tracking_submitted_at IS NULL — webhook
  //       flipped us to shipped but the Etsy tracking PATCH failed silently;
  //       previously these rows were stranded.
  const { data: rows, error } = await db
    .from("orders")
    .select("id, status, printify_order_id, etsy_order_id, retry_count")
    .or("status.eq.submitted,and(status.eq.shipped,etsy_tracking_submitted_at.is.null)")
    .not("printify_order_id", "is", null);

  if (error) {
    log.error({ agent: "fulfillment", action: "tracking_poll_db_error", error: error.message });
    return result;
  }

  const orders = (rows ?? []) as Array<{
    id: string;
    status: string;
    printify_order_id: string;
    etsy_order_id: string;
    retry_count: number;
  }>;

  result.scanned = orders.length;

  for (const order of orders) {
    try {
      const detail = await getOrder(order.printify_order_id);

      if (SHIPPED_STATUSES.has(detail.status) && detail.tracking) {
        // For status='submitted' rows: flip to 'shipped' and write tracking.
        // For status='shipped' rows (re-attempting Etsy after a prior failure):
        // leave status alone but refresh tracking fields with what Printify
        // currently reports. Either way the local update is conditional —
        // a concurrent webhook can't race with us here.
        if (order.status === "submitted") {
          await db
            .from("orders")
            .update({
              tracking_number: detail.tracking.number,
              tracking_url: detail.tracking.url,
              status: "shipped",
            })
            .eq("id", order.id)
            .eq("status", "submitted");
        }

        // Post tracking back to Etsy (normalize carrier to Etsy's accepted enum)
        const normalizedCarrier = normalizeEtsyCarrierName(detail.tracking.carrier);
        if (!normalizedCarrier) {
          log.warn({
            agent: "fulfillment",
            action: "unknown_carrier",
            record_id: order.id,
            raw_carrier: detail.tracking.carrier,
          });
          await notifySlack(
            `Unknown carrier "${detail.tracking.carrier}" for order ${order.id} — tracking NOT submitted to Etsy`,
            { severity: "warn" }
          );
        } else {
          await submitTracking(db, order.etsy_order_id, {
            tracking_code: detail.tracking.number,
            carrier_name: normalizedCarrier,
          });
          // Mark Etsy as having received the tracking so the poller does not
          // re-fire for this row on every subsequent run (bug #30).
          await db
            .from("orders")
            .update({ etsy_tracking_submitted_at: new Date().toISOString() })
            .eq("id", order.id);
        }

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

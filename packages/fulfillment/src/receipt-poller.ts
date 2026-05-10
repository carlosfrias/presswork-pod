import { type Db, getLogger, listReceipts } from "@presswork/shared";
import { processOrder as defaultProcessOrder } from "./order-processor.js";
import type { ProcessOrderFn } from "./server.js";

export interface PollReceiptsResult {
  scanned: number;
  processed: number;
  skipped: number;
  errored: number;
}

export async function pollReceipts(
  db: Db,
  processOrder: ProcessOrderFn = defaultProcessOrder
): Promise<PollReceiptsResult> {
  const log = getLogger("fulfillment");
  const result: PollReceiptsResult = { scanned: 0, processed: 0, skipped: 0, errored: 0 };

  const receipts = await listReceipts(db, { was_paid: true, was_shipped: false, limit: 100 });
  result.scanned = receipts.length;

  for (const receipt of receipts) {
    try {
      const outcome = await processOrder(db, String(receipt.receipt_id));
      if (outcome.outcome === "duplicate") {
        result.skipped++;
      } else if (outcome.outcome === "error") {
        result.errored++;
      } else {
        result.processed++;
      }
    } catch (err) {
      result.errored++;
      log.error({
        agent: "fulfillment",
        action: "receipt_poll_item_error",
        receipt_id: receipt.receipt_id,
        error: String(err),
      });
    }
  }

  log.info({ agent: "fulfillment", action: "receipt_poll_done", ...result });
  return result;
}

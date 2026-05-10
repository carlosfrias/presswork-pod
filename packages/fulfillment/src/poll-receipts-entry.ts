import { getDb, getLogger } from "@presswork/shared";
import { pollReceipts } from "./receipt-poller.js";
import { processOrder } from "./order-processor.js";

const log = getLogger("fulfillment");
const db = getDb();

pollReceipts(db, processOrder)
  .then((stats) => {
    log.info({ agent: "fulfillment", action: "receipt_poll_done", ...stats, status: "ok" });
    process.exit(0);
  })
  .catch((err: unknown) => {
    log.error({ agent: "fulfillment", action: "receipt_poll_fail", error: String(err), status: "error" });
    process.exit(1);
  });

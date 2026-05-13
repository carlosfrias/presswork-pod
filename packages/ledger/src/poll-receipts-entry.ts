import { getDb, getLogger } from "@presswork/shared";
import { pollReceipts } from "./receipt-poller.js";

const log = getLogger("ledger");
const db = getDb();

pollReceipts(db)
  .then((stats) => {
    log.info({ agent: "ledger", action: "receipt_poll_done", ...stats, status: "ok" });
    process.exit(0);
  })
  .catch((err: unknown) => {
    log.error({ agent: "ledger", action: "receipt_poll_fail", error: String(err), status: "error" });
    process.exit(1);
  });

import { getDb, getLogger } from "@presswork/shared";
import { pollTracking } from "./tracking-poller.js";

const log = getLogger("fulfillment");
const db = getDb();

pollTracking(db)
  .then((stats) => {
    log.info({ agent: "fulfillment", action: "tracking_poll_done", ...stats, status: "ok" });
    process.exit(0);
  })
  .catch((err: unknown) => {
    log.error({ agent: "fulfillment", action: "tracking_poll_fail", error: String(err), status: "error" });
    process.exit(1);
  });

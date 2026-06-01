import { getDb, getLogger } from "@presswork/shared";
import { runWatchdog } from "./watchdog.js";

const log = getLogger("ledger");
const db = getDb();

runWatchdog(db)
  .then((summary) => {
    log.info({
      agent: "ledger",
      action: "watchdog_done",
      totalStuck: summary.totalStuck,
      status: "ok",
    });
    process.exit(0);
  })
  .catch((err: unknown) => {
    log.error({
      agent: "ledger",
      action: "watchdog_fail",
      error: String(err),
      status: "error",
    });
    process.exit(1);
  });

import { getDb, getLogger } from "@presswork/shared";
import { runDailyDigest } from "./digest.js";

const log = getLogger("ledger");
const db = getDb();

runDailyDigest(db)
  .then((summary) => {
    log.info({ agent: "ledger", action: "daily_digest_done", ...summary, status: "ok" });
    process.exit(0);
  })
  .catch((err: unknown) => {
    log.error({ agent: "ledger", action: "daily_digest_fail", error: String(err), status: "error" });
    process.exit(1);
  });

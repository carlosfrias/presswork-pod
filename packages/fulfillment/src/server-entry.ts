import { getDb, getLogger } from "@presswork/shared";
import { createApp } from "./server.js";
import { processOrder } from "./order-processor.js";

const log = getLogger("fulfillment");
const db = getDb();
const app = createApp({ db, processOrder });
const port = Number(process.env["PORT"] ?? 3000);

const server = app.listen(port, () => {
  log.info({ agent: "fulfillment", action: "server_start", port, status: "ready" });
});

// Railway sends SIGTERM and waits ~30s before SIGKILL. Bound the in-flight
// request wait so a stuck connection can't block the whole shutdown; bind
// SIGINT too so local Ctrl-C behaves the same.
const SHUTDOWN_TIMEOUT_MS = 25_000;

function gracefulShutdown(signal: NodeJS.Signals): void {
  log.info({ agent: "fulfillment", action: "shutdown_start", signal });
  const force = setTimeout(() => {
    log.error({
      agent: "fulfillment",
      action: "shutdown_force_exit",
      signal,
      timeout_ms: SHUTDOWN_TIMEOUT_MS,
    });
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  // Clean exit shouldn't be held open by the timer.
  force.unref();

  server.close(() => {
    log.info({ agent: "fulfillment", action: "shutdown_complete", signal });
    process.exit(0);
  });
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

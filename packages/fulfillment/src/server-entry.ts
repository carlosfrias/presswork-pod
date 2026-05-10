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

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});

import express, { type Express } from "express";
import { type Db, getLogger, getSettings, getPrintifyErrorRate } from "@presswork/shared";
import { verifyEtsyWebhook } from "./webhook-verify.js";
import { handlePrintifyWebhook } from "./printify-webhook.js";
import type { ProcessOrderResult } from "./order-processor.js";

export type ProcessOrderFn = (
  db: Db,
  receiptId: string
) => Promise<ProcessOrderResult>;

interface AppDeps {
  db: Db;
  processOrder: ProcessOrderFn;
}

export function createApp(deps: AppDeps): Express {
  const app = express();

  // Raw body needed for HMAC verification on webhook routes
  app.use("/webhook/etsy-order", express.raw({ type: "*/*" }));
  app.use("/webhook/printify-order", express.raw({ type: "*/*" }));

  // JSON everywhere else
  app.use((req, res, next) => {
    if (req.path === "/webhook/etsy-order" || req.path === "/webhook/printify-order") return next();
    express.json()(req, res, next);
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/healthz/printify", (_req, res) => {
    res.json(getPrintifyErrorRate());
  });

  app.post("/webhook/printify-order", async (req, res) => {
    await handlePrintifyWebhook(req, res, deps.db);
  });

  app.post("/webhook/etsy-order", async (req, res) => {
    const log = getLogger("fulfillment");
    const { ETSY_API_SECRET } = getSettings();

    const rawBody = req.body as Buffer;
    const sigHeader = req.headers["x-etsy-signature"] as string | undefined;
    const tsHeader = req.headers["x-etsy-request-timestamp"] as string | undefined;

    const verification = verifyEtsyWebhook(rawBody, sigHeader, tsHeader, ETSY_API_SECRET);
    if (!verification.valid) {
      log.warn({
        agent: "fulfillment",
        action: "webhook_rejected",
        status: "invalid",
        reason: verification.reason,
      });
      res.status(401).json({ error: verification.reason });
      return;
    }

    let receiptId: string;
    try {
      const payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
      // Etsy webhooks use receipt_id; update if Etsy docs indicate a different field
      const id = payload["receipt_id"] ?? payload["id"];
      if (!id) throw new Error("No receipt_id in webhook payload");
      receiptId = String(id);
    } catch (parseErr) {
      log.error({ agent: "fulfillment", action: "webhook_parse_error", error: String(parseErr) });
      // Still respond 200 — a malformed Etsy payload won't improve on retry
      res.status(200).json({ ok: false, error: "parse_error" });
      return;
    }

    try {
      const result = await deps.processOrder(deps.db, receiptId);
      log.info({
        agent: "fulfillment",
        action: "webhook_processed",
        receipt_id: receiptId,
        outcome: result.outcome,
      });
    } catch (err) {
      // Absorb unexpected throws — Etsy aggressive retries would bypass our retry budget
      log.error({
        agent: "fulfillment",
        action: "webhook_unexpected_error",
        receipt_id: receiptId,
        error: String(err),
      });
    }

    // Always 200 — errors are tracked in DB; Etsy retrying doesn't help
    res.status(200).json({ ok: true });
  });

  return app;
}

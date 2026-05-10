import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { type Db, getLogger, getSettings, printifyFetch, submitTracking } from "@presswork/shared";

// Minimal webhook payload — only fields we act on
const PrintifyWebhookPayloadSchema = z.object({
  type: z.string(),
  resource: z.object({
    id: z.string(),
    type: z.string(),
    data: z.object({
      id: z.string(), // Printify order ID
      status: z.string().optional(),
      shipments: z
        .array(
          z.object({
            carrier: z.string().optional(),
            number: z.string().optional(),
            url: z.string().optional(),
          })
        )
        .optional(),
    }),
  }),
});

export type PrintifyWebhookVerifyResult =
  | { valid: true }
  | { valid: false; reason: "missing_secret" | "missing_signature" | "mismatch" };

// Printify signs payloads with HMAC-SHA256 and sends the result as base64
// in the X-Printify-Hmac-Sha256 header.
export function verifyPrintifyWebhook(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string | undefined
): PrintifyWebhookVerifyResult {
  if (!secret) return { valid: false, reason: "missing_secret" };
  if (!signatureHeader) return { valid: false, reason: "missing_signature" };

  const expected = createHmac("sha256", secret).update(rawBody).digest("base64");

  let expectedBuf: Buffer;
  let actualBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expected, "utf8");
    actualBuf = Buffer.from(signatureHeader, "utf8");
  } catch {
    return { valid: false, reason: "mismatch" };
  }

  if (expectedBuf.length !== actualBuf.length) return { valid: false, reason: "mismatch" };
  if (!timingSafeEqual(expectedBuf, actualBuf)) return { valid: false, reason: "mismatch" };

  return { valid: true };
}

export async function handlePrintifyWebhook(
  req: Request,
  res: Response,
  db: Db
): Promise<void> {
  const log = getLogger("fulfillment");
  const { PRINTIFY_WEBHOOK_SECRET } = getSettings();

  const rawBody = req.body as Buffer;
  const sigHeader = req.headers["x-printify-hmac-sha256"] as string | undefined;

  const verification = verifyPrintifyWebhook(rawBody, sigHeader, PRINTIFY_WEBHOOK_SECRET);
  if (!verification.valid) {
    log.warn({
      agent: "fulfillment",
      action: "printify_webhook_rejected",
      reason: verification.reason,
    });
    res.status(401).json({ error: verification.reason });
    return;
  }

  let payload: z.infer<typeof PrintifyWebhookPayloadSchema>;
  try {
    payload = PrintifyWebhookPayloadSchema.parse(
      JSON.parse(rawBody.toString("utf8")) as unknown
    );
  } catch (err) {
    log.error({ agent: "fulfillment", action: "printify_webhook_parse_error", error: String(err) });
    res.status(200).json({ ok: false, error: "parse_error" });
    return;
  }

  const printifyOrderId = payload.resource.data.id;
  const eventType = payload.type;

  const { data: orderRows, error: dbErr } = await db
    .from("orders")
    .select("id, etsy_order_id, status")
    .eq("printify_order_id", printifyOrderId)
    .limit(1);

  if (dbErr || !orderRows?.length) {
    log.warn({
      agent: "fulfillment",
      action: "printify_webhook_order_not_found",
      printify_order_id: printifyOrderId,
    });
    // 200 so Printify doesn't retry for orders we genuinely can't resolve
    res.status(200).json({ ok: true, skipped: "order_not_found" });
    return;
  }

  const order = orderRows[0]!;

  if (eventType === "order:shipment:created") {
    const shipment = payload.resource.data.shipments?.[0];
    if (!shipment?.number) {
      res.status(200).json({ ok: true, skipped: "no_tracking" });
      return;
    }

    // Idempotency: already processed this shipment
    if (order.status === "shipped") {
      res.status(200).json({ ok: true, skipped: "already_shipped" });
      return;
    }

    await db
      .from("orders")
      .update({ tracking_number: shipment.number, tracking_url: shipment.url ?? "", status: "shipped" })
      .eq("id", order.id);

    try {
      await submitTracking(db, order.etsy_order_id, {
        tracking_code: shipment.number,
        carrier_name: shipment.carrier ?? "",
      });
    } catch (err) {
      log.error({
        agent: "fulfillment",
        action: "printify_webhook_submit_tracking_error",
        record_id: order.id,
        error: String(err),
      });
    }

    log.info({
      agent: "fulfillment",
      action: "printify_webhook_shipped",
      record_id: order.id,
      tracking: shipment.number,
    });
  } else if (eventType === "order:updated") {
    const newStatus = payload.resource.data.status;

    // Idempotency: status unchanged
    if (!newStatus || order.status === newStatus) {
      res.status(200).json({ ok: true, skipped: "status_unchanged" });
      return;
    }

    await db.from("orders").update({ status: newStatus }).eq("id", order.id);

    log.info({
      agent: "fulfillment",
      action: "printify_webhook_status_updated",
      record_id: order.id,
      new_status: newStatus,
    });
  }

  res.status(200).json({ ok: true });
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────

const WEBHOOK_TOPICS = ["order:updated", "order:shipment:created"] as const;

export async function registerPrintifyWebhooks(db: Db): Promise<void> {
  const log = getLogger("fulfillment");
  const { PRINTIFY_SHOP_ID, PRINTIFY_WEBHOOK_BASE_URL, PRINTIFY_WEBHOOK_SECRET } = getSettings();

  if (!PRINTIFY_WEBHOOK_BASE_URL || !PRINTIFY_WEBHOOK_SECRET) {
    log.info({
      agent: "fulfillment",
      action: "printify_webhook_bootstrap_skipped",
      reason: "PRINTIFY_WEBHOOK_BASE_URL or PRINTIFY_WEBHOOK_SECRET not set",
    });
    return;
  }

  const targetUrl = `${PRINTIFY_WEBHOOK_BASE_URL}/webhook/printify-order`;

  const existing = (await printifyFetch(
    `/shops/${PRINTIFY_SHOP_ID}/webhooks.json`
  )) as Array<{ topic: string; url: string; id: string }>;

  for (const topic of WEBHOOK_TOPICS) {
    if (existing.some((w) => w.topic === topic && w.url === targetUrl)) {
      log.info({ agent: "fulfillment", action: "printify_webhook_already_registered", topic });
      continue;
    }

    const created = (await printifyFetch(
      `/shops/${PRINTIFY_SHOP_ID}/webhooks.json`,
      {
        method: "POST",
        body: JSON.stringify({ topic, url: targetUrl, secret: PRINTIFY_WEBHOOK_SECRET }),
      }
    )) as { id: string };

    try {
      await db
        .from("config")
        .upsert({ key: `printify_webhook_id_${topic}`, value: created.id }, { onConflict: "key" });
    } catch (err) {
      log.warn({
        agent: "fulfillment",
        action: "printify_webhook_id_store_failed",
        topic,
        error: String(err),
      });
    }

    log.info({
      agent: "fulfillment",
      action: "printify_webhook_registered",
      topic,
      webhook_id: created.id,
    });
  }
}

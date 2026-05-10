import { createHmac, timingSafeEqual } from "node:crypto";
import { WEBHOOK_TIMESTAMP_TOLERANCE_SEC } from "./constants.js";

export type WebhookVerifyResult =
  | { valid: true }
  | { valid: false; reason: "missing_secret" | "missing_signature" | "replay" | "mismatch" };

/**
 * Verifies an Etsy webhook signature using the Svix scheme.
 *
 * Etsy webhooks carry three headers: webhook-id, webhook-timestamp, and
 * webhook-signature (format: "v1,<base64sig>" — space-separated for key rotation).
 * The secret is provided by Etsy when the subscription is created, prefixed "whsec_"
 * followed by a base64-encoded key. Signed payload: "${id}.${timestamp}.${rawBody}".
 */
export function verifyEtsyWebhook(
  rawBody: Buffer,
  headers: {
    id: string | undefined;
    timestamp: string | undefined;
    signature: string | undefined;
  },
  secret: string | undefined
): WebhookVerifyResult {
  if (!secret) {
    return { valid: false, reason: "missing_secret" };
  }

  const { id, timestamp, signature } = headers;

  if (!id || !timestamp || !signature) {
    return { valid: false, reason: "missing_signature" };
  }

  const ts = parseInt(timestamp, 10);
  const nowSec = Math.floor(Date.now() / 1000);
  if (isNaN(ts) || Math.abs(nowSec - ts) > WEBHOOK_TIMESTAMP_TOLERANCE_SEC) {
    return { valid: false, reason: "replay" };
  }

  const decodedSecret = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signedPayload = `${id}.${timestamp}.${rawBody.toString("utf8")}`;
  const expectedSig = createHmac("sha256", decodedSecret).update(signedPayload).digest("base64");
  const expectedBuf = Buffer.from(expectedSig, "utf8");

  // Signature header may contain space-separated "v1,<b64sig>" entries (Svix key rotation)
  const sigEntries = signature.split(" ").map((s) => s.replace(/^v1,/, ""));
  for (const entry of sigEntries) {
    const entryBuf = Buffer.from(entry, "utf8");
    if (entryBuf.length === expectedBuf.length && timingSafeEqual(expectedBuf, entryBuf)) {
      return { valid: true };
    }
  }

  return { valid: false, reason: "mismatch" };
}

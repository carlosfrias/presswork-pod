import { createHmac, timingSafeEqual } from "node:crypto";
import { WEBHOOK_TIMESTAMP_TOLERANCE_SEC } from "./constants.js";

export type WebhookVerifyResult =
  | { valid: true }
  | { valid: false; reason: "missing_signature" | "replay" | "mismatch" };

/**
 * Verifies an Etsy webhook HMAC-SHA256 signature.
 *
 * Etsy signs payloads with HMAC-SHA256 of the raw request body using the
 * app's API secret. The signature is hex-encoded and sent in X-Etsy-Signature.
 * The request Unix timestamp is in X-Etsy-Request-Timestamp.
 *
 * Note: Etsy's exact signing format (e.g. whether the timestamp is included
 * in the signed string) should be confirmed against current Etsy webhook docs
 * when first handling live webhooks. Update this file if needed.
 */
export function verifyEtsyWebhook(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
  secret: string
): WebhookVerifyResult {
  if (!signatureHeader) {
    return { valid: false, reason: "missing_signature" };
  }

  if (timestampHeader) {
    const ts = parseInt(timestampHeader, 10);
    const nowSec = Math.floor(Date.now() / 1000);
    if (isNaN(ts) || Math.abs(nowSec - ts) > WEBHOOK_TIMESTAMP_TOLERANCE_SEC) {
      return { valid: false, reason: "replay" };
    }
  }

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");

  let expectedBuf: Buffer;
  let actualBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expected, "utf8");
    actualBuf = Buffer.from(signatureHeader, "utf8");
  } catch {
    return { valid: false, reason: "mismatch" };
  }

  if (expectedBuf.length !== actualBuf.length) {
    return { valid: false, reason: "mismatch" };
  }

  if (!timingSafeEqual(expectedBuf, actualBuf)) {
    return { valid: false, reason: "mismatch" };
  }

  return { valid: true };
}

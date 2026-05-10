import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyEtsyWebhook } from "./webhook-verify.js";

// whsec_ prefix + base64("test-secret")
const SECRET = "whsec_dGVzdC1zZWNyZXQ=";
const BODY = Buffer.from('{"receipt_id":42}');
const NOW_SEC = Math.floor(Date.now() / 1000);
const MSG_ID = "msg_2M4Z3QeS8uLzHN3j8YdF9eZl";

function svixSign(secret: string, id: string, ts: string, body: Buffer): string {
  const decoded = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", decoded)
    .update(`${id}.${ts}.${body.toString("utf8")}`)
    .digest("base64");
  return `v1,${sig}`;
}

describe("verifyEtsyWebhook", () => {
  it("returns valid=true for a correct Svix signature", () => {
    const sig = svixSign(SECRET, MSG_ID, String(NOW_SEC), BODY);
    const result = verifyEtsyWebhook(
      BODY,
      { id: MSG_ID, timestamp: String(NOW_SEC), signature: sig },
      SECRET
    );
    expect(result.valid).toBe(true);
  });

  it("accepts a secret with whsec_ prefix (strips prefix before decode)", () => {
    const sig = svixSign(SECRET, MSG_ID, String(NOW_SEC), BODY);
    const result = verifyEtsyWebhook(
      BODY,
      { id: MSG_ID, timestamp: String(NOW_SEC), signature: sig },
      SECRET
    );
    expect(result.valid).toBe(true);
  });

  it("accepts a valid sig in a space-separated multi-sig header", () => {
    const goodSig = svixSign(SECRET, MSG_ID, String(NOW_SEC), BODY);
    const multiSig = `v1,oldsig123 ${goodSig}`;
    const result = verifyEtsyWebhook(
      BODY,
      { id: MSG_ID, timestamp: String(NOW_SEC), signature: multiSig },
      SECRET
    );
    expect(result.valid).toBe(true);
  });

  it("returns missing_secret when secret is undefined", () => {
    const sig = svixSign(SECRET, MSG_ID, String(NOW_SEC), BODY);
    const result = verifyEtsyWebhook(
      BODY,
      { id: MSG_ID, timestamp: String(NOW_SEC), signature: sig },
      undefined
    );
    expect(result).toEqual({ valid: false, reason: "missing_secret" });
  });

  it("returns missing_signature when webhook-id is absent", () => {
    const sig = svixSign(SECRET, MSG_ID, String(NOW_SEC), BODY);
    const result = verifyEtsyWebhook(
      BODY,
      { id: undefined, timestamp: String(NOW_SEC), signature: sig },
      SECRET
    );
    expect(result).toEqual({ valid: false, reason: "missing_signature" });
  });

  it("returns missing_signature when webhook-timestamp is absent", () => {
    const sig = svixSign(SECRET, MSG_ID, String(NOW_SEC), BODY);
    const result = verifyEtsyWebhook(
      BODY,
      { id: MSG_ID, timestamp: undefined, signature: sig },
      SECRET
    );
    expect(result).toEqual({ valid: false, reason: "missing_signature" });
  });

  it("returns missing_signature when webhook-signature is absent", () => {
    const result = verifyEtsyWebhook(
      BODY,
      { id: MSG_ID, timestamp: String(NOW_SEC), signature: undefined },
      SECRET
    );
    expect(result).toEqual({ valid: false, reason: "missing_signature" });
  });

  it("returns mismatch when body is tampered", () => {
    const sig = svixSign(SECRET, MSG_ID, String(NOW_SEC), BODY);
    const tamperedBody = Buffer.from('{"receipt_id":99}');
    const result = verifyEtsyWebhook(
      tamperedBody,
      { id: MSG_ID, timestamp: String(NOW_SEC), signature: sig },
      SECRET
    );
    expect(result).toEqual({ valid: false, reason: "mismatch" });
  });

  it("returns replay when timestamp is more than 5 minutes old", () => {
    const oldTs = String(NOW_SEC - 400);
    const sig = svixSign(SECRET, MSG_ID, oldTs, BODY);
    const result = verifyEtsyWebhook(
      BODY,
      { id: MSG_ID, timestamp: oldTs, signature: sig },
      SECRET
    );
    expect(result).toEqual({ valid: false, reason: "replay" });
  });

  it("returns mismatch for a wrong signature (length-mismatch buffer guard)", () => {
    const result = verifyEtsyWebhook(
      BODY,
      { id: MSG_ID, timestamp: String(NOW_SEC), signature: "v1,short" },
      SECRET
    );
    expect(result).toEqual({ valid: false, reason: "mismatch" });
  });
});

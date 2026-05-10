import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyEtsyWebhook } from "./webhook-verify.js";

const SECRET = "test-secret";
const BODY = Buffer.from('{"receipt_id":42}');
const NOW_SEC = Math.floor(Date.now() / 1000);

function sign(body: Buffer, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyEtsyWebhook", () => {
  it("returns valid=true for a correct signature", () => {
    const sig = sign(BODY, SECRET);
    const result = verifyEtsyWebhook(BODY, sig, String(NOW_SEC), SECRET);
    expect(result.valid).toBe(true);
  });

  it("returns missing_signature when signature header is absent", () => {
    const result = verifyEtsyWebhook(BODY, undefined, String(NOW_SEC), SECRET);
    expect(result).toEqual({ valid: false, reason: "missing_signature" });
  });

  it("returns missing_signature when signature header is empty string", () => {
    const result = verifyEtsyWebhook(BODY, "", String(NOW_SEC), SECRET);
    expect(result).toEqual({ valid: false, reason: "missing_signature" });
  });

  it("returns mismatch when body is tampered", () => {
    const sig = sign(BODY, SECRET);
    const tamperedBody = Buffer.from('{"receipt_id":99}');
    const result = verifyEtsyWebhook(tamperedBody, sig, String(NOW_SEC), SECRET);
    expect(result).toEqual({ valid: false, reason: "mismatch" });
  });

  it("returns mismatch when signature is wrong", () => {
    const result = verifyEtsyWebhook(BODY, "deadbeef", String(NOW_SEC), SECRET);
    expect(result).toEqual({ valid: false, reason: "mismatch" });
  });

  it("returns replay when timestamp is more than 5 minutes old", () => {
    const sig = sign(BODY, SECRET);
    const oldTs = String(NOW_SEC - 400);
    const result = verifyEtsyWebhook(BODY, sig, oldTs, SECRET);
    expect(result).toEqual({ valid: false, reason: "replay" });
  });

  it("returns replay when timestamp is in the far future", () => {
    const sig = sign(BODY, SECRET);
    const futureTs = String(NOW_SEC + 400);
    const result = verifyEtsyWebhook(BODY, sig, futureTs, SECRET);
    expect(result).toEqual({ valid: false, reason: "replay" });
  });

  it("allows a timestamp within the 5-minute window", () => {
    const sig = sign(BODY, SECRET);
    const recentTs = String(NOW_SEC - 200);
    const result = verifyEtsyWebhook(BODY, sig, recentTs, SECRET);
    expect(result.valid).toBe(true);
  });

  it("returns mismatch for a signature of different length (guards buffer compare)", () => {
    const result = verifyEtsyWebhook(BODY, "short", String(NOW_SEC), SECRET);
    expect(result).toEqual({ valid: false, reason: "mismatch" });
  });
});

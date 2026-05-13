import { describe, it, expect } from "vitest";
import {
  TrendBriefStatusSchema,
  DesignPackageStatusSchema,
  ListingStatusSchema,
} from "../src/types.js";

// Parity guard: the zod status enums must accept every value the live
// state machine writes. The previous schemas (pre-AUDIT_4 H1) listed only
// the pre-review-gate values and threw on legitimate rows. This test
// codifies the migration-021+ state machine so a regression shows up as
// a unit-test failure instead of a Listing-poller crash.
describe("status schemas — migration 021 parity", () => {
  it("TrendBriefStatusSchema accepts the full live state machine", () => {
    const required = [
      "pending",
      "needs_review",
      "needs_description",
      "approved",
      "processing",
      "done",
      "error",
    ] as const;
    for (const status of required) {
      expect(() => TrendBriefStatusSchema.parse(status)).not.toThrow();
    }
  });

  it("DesignPackageStatusSchema accepts the full live state machine", () => {
    const required = [
      "pending",
      "needs_review",
      "approved",
      "processing",
      "done",
      "error",
    ] as const;
    for (const status of required) {
      expect(() => DesignPackageStatusSchema.parse(status)).not.toThrow();
    }
  });

  it("ListingStatusSchema accepts the full live state machine", () => {
    const required = [
      "pending",
      "needs_review",
      "pending_publish",
      "publishing",
      "active",
      "error",
    ] as const;
    for (const status of required) {
      expect(() => ListingStatusSchema.parse(status)).not.toThrow();
    }
  });

  it("rejects values outside the enum", () => {
    expect(() => TrendBriefStatusSchema.parse("bogus")).toThrow();
    expect(() => DesignPackageStatusSchema.parse("bogus")).toThrow();
    expect(() => ListingStatusSchema.parse("bogus")).toThrow();
  });
});

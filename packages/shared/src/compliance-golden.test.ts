/**
 * Golden fixture tests for Etsy seller-policy compliance.
 *
 * These tests assert that every hard gate defined in ## Etsy Seller Policy
 * Compliance (CLAUDE.md) behaves correctly against a fixture matrix. The suite
 * is complementary to etsy-compliance.test.ts (unit-level); it adds:
 *
 *   - A compliant BASELINE fixture that must pass all validators cleanly.
 *   - A VIOLATING fixture per rule that must throw ComplianceError with the
 *     right message.
 *   - Rule 1 (production-partner ID) — edge-value matrix.
 *   - Rule 4 (mockup provenance) — edge-value matrix.
 *   - Rule 5 (single-shop invariant) — no copy validator exists; coverage is
 *     provided via a documented assertion (see dedicated describe block below).
 *   - sanitizeListingCopy snapshot (messy input → locked output shape).
 */

import { describe, it, expect } from "vitest";
import {
  validateCopyCompliance,
  validateAiDisclosure,
  validateNoForbiddenTerms,
  validateNoOffPlatform,
  validateProductionPartnerId,
  validateMockupProvenance,
  validateNoEmDash,
  sanitizeListingCopy,
} from "./etsy-compliance.js";
import { ETSY_SHOP_NAME, AI_DISCLOSURE_TEXT } from "./constants.js";
import {
  COMPLIANT_BASELINE,
  VIOLATING_FIXTURES,
  MESSY_LISTING_COPY,
} from "./__fixtures__/listing-compliance-fixtures.js";

// ---------------------------------------------------------------------------
// Rule 0 (implied) — COMPLIANT BASELINE passes every gate
// ---------------------------------------------------------------------------

describe("COMPLIANT_BASELINE passes all validators", () => {
  it("passes validateCopyCompliance without throwing", () => {
    expect(() => validateCopyCompliance(COMPLIANT_BASELINE)).not.toThrow();
  });

  it("passes validateAiDisclosure", () => {
    expect(() => validateAiDisclosure(COMPLIANT_BASELINE.description)).not.toThrow();
  });

  it("passes validateNoForbiddenTerms on all copy", () => {
    const allCopy = [
      COMPLIANT_BASELINE.title,
      COMPLIANT_BASELINE.description,
      ...COMPLIANT_BASELINE.tags,
    ].join("\n");
    expect(() => validateNoForbiddenTerms(allCopy)).not.toThrow();
  });

  it("passes validateNoOffPlatform on all copy", () => {
    const allCopy = [
      COMPLIANT_BASELINE.title,
      COMPLIANT_BASELINE.description,
      ...COMPLIANT_BASELINE.tags,
    ].join("\n");
    expect(() => validateNoOffPlatform(allCopy)).not.toThrow();
  });

  it("passes validateNoEmDash on all copy", () => {
    const allCopy = [
      COMPLIANT_BASELINE.title,
      COMPLIANT_BASELINE.description,
      ...COMPLIANT_BASELINE.tags,
    ].join("\n");
    expect(() => validateNoEmDash(allCopy)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// VIOLATING FIXTURES — fixture-driven matrix
// Each violating fixture must throw ComplianceError from validateCopyCompliance,
// and the error message must reference the triggering term/reason.
// ---------------------------------------------------------------------------

describe("VIOLATING_FIXTURES each cause validateCopyCompliance to throw ComplianceError", () => {
  it.each(VIOLATING_FIXTURES)(
    "$label",
    ({ copy, triggerSubstring }) => {
      expect(() => validateCopyCompliance(copy)).toThrowError(
        expect.objectContaining({
          name: "ComplianceError",
          message: expect.stringContaining(triggerSubstring),
        })
      );
    }
  );
});

// ---------------------------------------------------------------------------
// Rule 1 — validateProductionPartnerId edge-value matrix
// ---------------------------------------------------------------------------

describe("Rule 1: validateProductionPartnerId", () => {
  it("passes for a valid positive integer", () => {
    expect(() => validateProductionPartnerId(12345)).not.toThrow();
  });

  it("passes for the number 1 (minimum valid positive int)", () => {
    expect(() => validateProductionPartnerId(1)).not.toThrow();
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["0", 0],
    ["-1", -1],
    ["NaN", NaN],
  ] as const)("throws ComplianceError for %s", (_, id) => {
    expect(() => validateProductionPartnerId(id as never)).toThrowError(
      expect.objectContaining({ name: "ComplianceError" })
    );
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — validateAiDisclosure (individual validator, beyond fixture matrix)
// ---------------------------------------------------------------------------

describe("Rule 2: validateAiDisclosure", () => {
  it("throws ComplianceError when AI disclosure is absent", () => {
    expect(() => validateAiDisclosure("A nice tee shirt.")).toThrowError(
      expect.objectContaining({
        name: "ComplianceError",
        message: expect.stringContaining("AI disclosure missing"),
      })
    );
  });

  it("passes when description contains the verbatim disclosure", () => {
    expect(() => validateAiDisclosure(`A nice tee. ${AI_DISCLOSURE_TEXT}`)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — validateNoForbiddenTerms (spot-check a few that the fixture matrix
// does not directly test to keep coverage diversified)
// ---------------------------------------------------------------------------

describe("Rule 3: validateNoForbiddenTerms additional spot-checks", () => {
  it("rejects 'while supplies last'", () => {
    expect(() => validateNoForbiddenTerms("While supplies last!")).toThrowError(
      expect.objectContaining({
        name: "ComplianceError",
        message: expect.stringContaining("while supplies last"),
      })
    );
  });

  it("rejects 'handcrafted'", () => {
    expect(() => validateNoForbiddenTerms("Handcrafted with care.")).toThrowError(
      expect.objectContaining({ name: "ComplianceError" })
    );
  });

  it("does not reject 'hand-selected' in the AI disclosure itself", () => {
    // The AI_DISCLOSURE_TEXT contains 'hand-selected' — the validator must
    // strip the disclosure before scanning so it never fires on its own text.
    expect(() => validateNoForbiddenTerms(AI_DISCLOSURE_TEXT)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Rule 4 — validateMockupProvenance edge-value matrix
// ---------------------------------------------------------------------------

describe("Rule 4: validateMockupProvenance", () => {
  it("passes when flag is true", () => {
    expect(() => validateMockupProvenance(true)).not.toThrow();
  });

  it.each([
    ["false", false],
    ["undefined", undefined],
    ["null", null],
  ] as const)("throws ComplianceError when flag is %s", (_, flag) => {
    expect(() => validateMockupProvenance(flag as never)).toThrowError(
      expect.objectContaining({ name: "ComplianceError" })
    );
  });
});

// ---------------------------------------------------------------------------
// Rule 5 — Single-shop invariant (OPERATIONAL — no copy validator)
//
// Etsy's Seller Policy prohibits operating multiple shops or accounts through
// the same pipeline. Enforcement here is operational: the codebase is wired to
// a SINGLE shop ID (ETSY_SHOP_ID env var) and a SINGLE shop name constant
// (ETSY_SHOP_NAME). There is no copy-level validator because the rule is
// structural, not a function of listing text.
//
// This block makes Rule 5 visible in the test suite and guards against the
// constant being accidentally removed or made ambiguous.
// ---------------------------------------------------------------------------

describe("Rule 5: single-shop invariant (operational, no copy validator)", () => {
  it("ETSY_SHOP_NAME is defined and is a non-empty string", () => {
    expect(typeof ETSY_SHOP_NAME).toBe("string");
    expect(ETSY_SHOP_NAME.length).toBeGreaterThan(0);
  });

  it("ETSY_SHOP_NAME equals the expected single authorised shop", () => {
    // If this test fails after a rename, update ETSY_SHOP_NAME in constants.ts
    // AND verify the Etsy Shop Manager configuration matches.
    expect(ETSY_SHOP_NAME).toBe("BassetAndBirch");
  });

  it("there is only one shop-name constant (no second shop defined)", async () => {
    // Importing the constants module should not expose a second shop name.
    // This is a static guard: if someone adds ETSY_SHOP_NAME_2 the test will
    // surface the change for review.
    const mod = await import("./constants.js");
    const shopNameKeys = Object.keys(mod).filter((k) =>
      k.toLowerCase().includes("shop_name")
    );
    expect(shopNameKeys).toEqual(["ETSY_SHOP_NAME"]);
  });
});

// ---------------------------------------------------------------------------
// Rule 6 — validateNoOffPlatform (sub-cases already in fixture matrix; this
// block adds a few boundary cases to confirm the word-boundary matcher does
// not over-fire on benign text)
// ---------------------------------------------------------------------------

describe("Rule 6: validateNoOffPlatform boundary cases", () => {
  it("does not reject copy that mentions Etsy by name (on-platform)", () => {
    // "outside etsy" is a forbidden phrase, so we test with copy that
    // references Etsy without triggering any off-platform phrase.
    expect(() =>
      validateNoOffPlatform("Ships via Etsy's standard fulfillment. Questions? Use Etsy Messages.")
    ).not.toThrow();
  });

  it("rejects a bare linktr.ee-style domain", () => {
    expect(() =>
      validateNoOffPlatform("More designs at linktree.com/mybrand")
    ).toThrowError(expect.objectContaining({ name: "ComplianceError" }));
  });

  it("rejects 'dm us' as an off-platform phrase", () => {
    expect(() => validateNoOffPlatform("DM us for wholesale.")).toThrowError(
      expect.objectContaining({ name: "ComplianceError" })
    );
  });
});

// ---------------------------------------------------------------------------
// Em/en dash copy-style rule (individual validator)
// ---------------------------------------------------------------------------

describe("Em/en dash rule: validateNoEmDash beyond fixture matrix", () => {
  it("throws on a figure dash (U+2012, ‒)", () => {
    expect(() => validateNoEmDash("Ships in 3‒5 days.")).toThrowError(
      expect.objectContaining({ name: "ComplianceError" })
    );
  });

  it("throws on a horizontal bar (U+2015, ―)", () => {
    expect(() => validateNoEmDash("Quality tee ― worth every penny.")).toThrowError(
      expect.objectContaining({ name: "ComplianceError" })
    );
  });

  it("does not reject a plain ASCII hyphen-minus", () => {
    expect(() => validateNoEmDash("Made-to-order, ships in 2-4 weeks.")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// sanitizeListingCopy snapshot — messy input → owned output shape is locked
//
// If this snapshot breaks, review the diff carefully: the output shape is the
// contract that goes live. Approve the update ONLY when the change is
// intentional (e.g. a stripEmDashes logic fix).
// ---------------------------------------------------------------------------

describe("sanitizeListingCopy snapshot — messy input", () => {
  it("produces a deterministic, compliant output from MESSY_LISTING_COPY", () => {
    const result = sanitizeListingCopy(MESSY_LISTING_COPY);
    expect(result).toMatchSnapshot();
  });

  it("the sanitized output passes validateCopyCompliance", () => {
    const result = sanitizeListingCopy(MESSY_LISTING_COPY);
    expect(() => validateCopyCompliance(result)).not.toThrow();
  });
});

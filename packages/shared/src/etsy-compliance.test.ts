import { describe, it, expect } from "vitest";
import {
  stripEmDashes,
  validateNoEmDash,
  sanitizeListingCopy,
  validateCopyCompliance,
  ensureValidTags,
  ComplianceError,
} from "./etsy-compliance.js";
import { AI_DISCLOSURE_TEXT } from "./constants.js";

describe("stripEmDashes", () => {
  it("replaces a clause-break em dash with a comma", () => {
    expect(stripEmDashes("Cozy tee — perfect for winter")).toBe(
      "Cozy tee, perfect for winter"
    );
  });

  it("replaces an em dash with no surrounding spaces", () => {
    expect(stripEmDashes("cats—dogs")).toBe("cats, dogs");
  });

  it("replaces en dashes too", () => {
    expect(stripEmDashes("soft – warm – durable")).toBe("soft, warm, durable");
  });

  it("keeps numeric ranges as a hyphen", () => {
    expect(stripEmDashes("ships in 2–4 weeks")).toBe("ships in 2-4 weeks");
  });

  it("leaves ordinary hyphens alone", () => {
    expect(stripEmDashes("made-to-order hand-selected")).toBe(
      "made-to-order hand-selected"
    );
  });

  it("does not leave a doubled comma or stray space when the dash follows a comma context", () => {
    expect(stripEmDashes("Bold, bright — and fun")).toBe("Bold, bright, and fun");
  });

  it("is idempotent", () => {
    const once = stripEmDashes("Cozy tee — perfect — for winter");
    expect(stripEmDashes(once)).toBe(once);
  });
});

describe("validateNoEmDash", () => {
  it("throws when an em dash is present", () => {
    expect(() => validateNoEmDash("a — b")).toThrow(ComplianceError);
  });

  it("throws when an en dash is present", () => {
    expect(() => validateNoEmDash("a – b")).toThrow(ComplianceError);
  });

  it("passes for plain hyphenated copy", () => {
    expect(() => validateNoEmDash("made-to-order, ships in 2-4 weeks")).not.toThrow();
  });
});

describe("ensureValidTags drops dash lookalikes", () => {
  it("removes an em dash from a tag", () => {
    expect(ensureValidTags(["cat—lover"])).toEqual(["cat lover"]);
  });
});

describe("sanitizeListingCopy", () => {
  it("strips dashes from title + description and guarantees the disclosure", () => {
    const out = sanitizeListingCopy({
      title: "Cat Tee — Soft Cotton",
      description: "A great shirt — grab yours today.",
      tags: ["cat tee", "cat—lover"],
    });
    expect(out.title).toBe("Cat Tee, Soft Cotton");
    expect(out.description).toContain("A great shirt, grab yours today.");
    expect(out.description).toContain(AI_DISCLOSURE_TEXT);
    expect(out.tags).toEqual(["cat tee", "cat lover"]);
  });

  it("leaves the verbatim AI disclosure intact (no dashes in it to strip)", () => {
    const out = sanitizeListingCopy({
      title: "Tee",
      description: `Nice tee. ${AI_DISCLOSURE_TEXT}`,
      tags: [],
    });
    expect(out.description).toContain(AI_DISCLOSURE_TEXT);
  });

  it("produces copy that passes validateCopyCompliance", () => {
    const out = sanitizeListingCopy({
      title: "Cat Tee — Soft Cotton",
      description: "A great shirt — grab yours today.",
      tags: ["cat tee"],
    });
    expect(() => validateCopyCompliance(out)).not.toThrow();
  });
});

describe("validateCopyCompliance rejects em dashes", () => {
  it("throws on an em dash in the description", () => {
    expect(() =>
      validateCopyCompliance({
        title: "Cat Tee",
        description: `A great shirt — grab yours. ${AI_DISCLOSURE_TEXT}`,
        tags: ["cat tee"],
      })
    ).toThrow(ComplianceError);
  });
});

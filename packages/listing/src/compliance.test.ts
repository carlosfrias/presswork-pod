import { describe, it, expect } from "vitest";
import { AI_DISCLOSURE_TEXT } from "@presswork/shared";
import {
  ComplianceError,
  validateAiDisclosure,
  validateCopyCompliance,
  validateMockupProvenance,
  validateNoForbiddenTerms,
  validateNoOffPlatform,
  validateProductionPartnerId,
} from "./compliance.js";

const okDescription = `Cute soft tee for cat lovers. Great gift for a friend. ${AI_DISCLOSURE_TEXT}`;
const okTags = Array(13).fill("cat tee");
const okTitle = "Funny Cat T-Shirt for Cat Lovers";

describe("validateAiDisclosure", () => {
  it("passes when the verbatim disclosure is present", () => {
    expect(() => validateAiDisclosure(okDescription)).not.toThrow();
  });

  it("throws when missing", () => {
    expect(() => validateAiDisclosure("no disclosure here")).toThrow(ComplianceError);
  });

  it("throws when paraphrased rather than verbatim", () => {
    expect(() =>
      validateAiDisclosure("This was made with AI image tools and reviewed by a human.")
    ).toThrow(ComplianceError);
  });
});

describe("validateNoForbiddenTerms", () => {
  it("passes on clean copy", () => {
    expect(() => validateNoForbiddenTerms(okDescription)).not.toThrow();
  });

  it("does not flag the disclosure's 'hand-selected' wording", () => {
    // The disclosure literally contains 'hand-selected'. The validator must strip
    // the disclosure before scanning so it is not falsely matched against the
    // manual-creation blocklist.
    expect(() => validateNoForbiddenTerms(AI_DISCLOSURE_TEXT)).not.toThrow();
  });

  it("rejects 'handmade'", () => {
    expect(() => validateNoForbiddenTerms("a handmade gift")).toThrow(ComplianceError);
  });

  it("rejects 'hand-drawn' (hyphenated variant)", () => {
    expect(() => validateNoForbiddenTerms("hand-drawn cat illustration")).toThrow(
      ComplianceError
    );
  });

  it("rejects 'unique'", () => {
    expect(() => validateNoForbiddenTerms("a unique design")).toThrow(ComplianceError);
  });

  it("does not falsely match 'unique' inside 'techniques'", () => {
    expect(() =>
      validateNoForbiddenTerms("modern printing techniques are used")
    ).not.toThrow();
  });

  it("rejects 'one of a kind'", () => {
    expect(() => validateNoForbiddenTerms("a one of a kind print")).toThrow(ComplianceError);
  });

  it("rejects 'limited edition'", () => {
    expect(() => validateNoForbiddenTerms("limited edition gift item")).toThrow(
      ComplianceError
    );
  });
});

describe("validateNoOffPlatform", () => {
  it("passes clean copy", () => {
    expect(() => validateNoOffPlatform(okDescription)).not.toThrow();
  });

  it("rejects an https URL", () => {
    expect(() => validateNoOffPlatform("buy at https://example.com")).toThrow(ComplianceError);
  });

  it("rejects a www. URL", () => {
    expect(() => validateNoOffPlatform("see www.example.com for more")).toThrow(
      ComplianceError
    );
  });

  it("rejects a social handle", () => {
    expect(() => validateNoOffPlatform("follow @mystore today")).toThrow(ComplianceError);
  });

  it("rejects 'follow us on' phrasing", () => {
    expect(() => validateNoOffPlatform("follow us on instagram")).toThrow(ComplianceError);
  });

  it("rejects 'instagram.com' domain mention", () => {
    expect(() => validateNoOffPlatform("we are at instagram.com/x")).toThrow(ComplianceError);
  });
});

describe("validateProductionPartnerId", () => {
  it("passes a positive integer", () => {
    expect(() => validateProductionPartnerId(12345)).not.toThrow();
  });

  it("rejects undefined / null / 0 / NaN", () => {
    expect(() => validateProductionPartnerId(undefined)).toThrow(ComplianceError);
    expect(() => validateProductionPartnerId(null)).toThrow(ComplianceError);
    expect(() => validateProductionPartnerId(0)).toThrow(ComplianceError);
    expect(() => validateProductionPartnerId(NaN)).toThrow(ComplianceError);
    expect(() => validateProductionPartnerId(-1)).toThrow(ComplianceError);
  });
});

describe("validateMockupProvenance", () => {
  it("passes when flag is true", () => {
    expect(() => validateMockupProvenance(true)).not.toThrow();
  });

  it("rejects false / null / undefined", () => {
    expect(() => validateMockupProvenance(false)).toThrow(ComplianceError);
    expect(() => validateMockupProvenance(null)).toThrow(ComplianceError);
    expect(() => validateMockupProvenance(undefined)).toThrow(ComplianceError);
  });
});

describe("validateCopyCompliance", () => {
  it("passes a fully-compliant copy bundle", () => {
    expect(() =>
      validateCopyCompliance({
        title: okTitle,
        description: okDescription,
        tags: okTags,
      })
    ).not.toThrow();
  });

  it("flags forbidden terms in tags, not just description", () => {
    expect(() =>
      validateCopyCompliance({
        title: okTitle,
        description: okDescription,
        tags: [...okTags.slice(0, 12), "handmade tee"],
      })
    ).toThrow(ComplianceError);
  });

  it("flags off-platform URL in title", () => {
    expect(() =>
      validateCopyCompliance({
        title: "buy at www.shop.example.com",
        description: okDescription,
        tags: okTags,
      })
    ).toThrow(ComplianceError);
  });
});

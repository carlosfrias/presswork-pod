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

  // Bug #15 regression: every space-containing forbidden phrase needs to match
  // in multiple sentence positions, not just the start. The audit suspected the
  // boundary regex could silently miss them mid-sentence.
  describe.each([
    "hand made",
    "hand-made",
    "one of a kind",
    "one-of-a-kind",
    "limited edition",
    "limited availability",
    "limited quantity",
    "only a few left",
    "exclusive offer",
    "while supplies last",
  ])("multi-word forbidden term: %s (bug #15)", (term) => {
    it(`rejects at start of string: "${term} ..."`, () => {
      expect(() => validateNoForbiddenTerms(`${term} cat tee for sale`)).toThrow(
        ComplianceError
      );
    });

    it(`rejects mid-sentence with leading space: "... ${term} ..."`, () => {
      expect(() => validateNoForbiddenTerms(`get this ${term} shirt today`)).toThrow(
        ComplianceError
      );
    });

    it(`rejects with surrounding punctuation: ". ${term}!"`, () => {
      expect(() => validateNoForbiddenTerms(`Awesome. ${term}!`)).toThrow(ComplianceError);
    });

    it(`rejects at end of string: "... ${term}"`, () => {
      expect(() => validateNoForbiddenTerms(`this design is ${term}`)).toThrow(
        ComplianceError
      );
    });
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

  // bug #21 — emails must NOT trigger SOCIAL_HANDLE_PATTERN
  it("does not reject a benign email address (bug #21)", () => {
    expect(() =>
      validateNoOffPlatform("contact me at help@example.org for questions")
    ).not.toThrow();
  });

  it("still rejects an @handle preceded by whitespace", () => {
    expect(() =>
      validateNoOffPlatform("find me at @mystore for updates")
    ).toThrow(ComplianceError);
  });

  // bug #22 — word-boundary off-platform phrases
  it("does not falsely match 'find us on' inside 'find user solutions on' (bug #22)", () => {
    expect(() =>
      validateNoOffPlatform("we can help you find user solutions on the platform")
    ).not.toThrow();
  });

  it("rejects 'find us on' as a phrase (bug #22)", () => {
    expect(() =>
      validateNoOffPlatform("find us on instagram for more cat designs")
    ).toThrow(ComplianceError);
  });

  // bug #23 — bare domains
  it("rejects a bare domain like mystore.com (bug #23)", () => {
    expect(() =>
      validateNoOffPlatform("buy at mystore.com to skip Etsy fees")
    ).toThrow(ComplianceError);
  });

  it("rejects a bare domain with subdomain + path like linktr.ee/x (bug #23)", () => {
    expect(() =>
      validateNoOffPlatform("more at linktr.ee/x")
    ).toThrow(ComplianceError);
  });

  it("does not falsely match version-like strings (bug #23)", () => {
    expect(() =>
      validateNoOffPlatform("v1.2 of our soft cotton tee")
    ).not.toThrow();
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

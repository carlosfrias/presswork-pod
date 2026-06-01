/**
 * Golden fixtures for Etsy seller-policy compliance tests.
 *
 * Each fixture is a minimal listing-copy triple (title, description, tags)
 * paired with metadata describing which rule it violates (if any) and the
 * specific substring that trips the gate.
 *
 * Rule numbering matches ## Etsy Seller Policy Compliance in CLAUDE.md:
 *   1  Production-partner disclosure  -> validateProductionPartnerId
 *   2  AI disclosure verbatim         -> validateAiDisclosure / validateCopyCompliance
 *   3  No manual-creation / scarcity  -> validateNoForbiddenTerms
 *   4  Mockups from actual design     -> validateMockupProvenance
 *   5  Single shop (BassetAndBirch)   -> OPERATIONAL, no copy validator (see test)
 *   6  No off-platform content        -> validateNoOffPlatform
 *   +  Em/en dash ban                 -> validateNoEmDash
 */

import { AI_DISCLOSURE_TEXT } from "../constants.js";

// ---------------------------------------------------------------------------
// Copy triple shape
// ---------------------------------------------------------------------------

export interface ListingCopy {
  title: string;
  description: string;
  tags: string[];
}

// ---------------------------------------------------------------------------
// COMPLIANT BASELINE
// All six copy-side rules satisfied; passes validateCopyCompliance cleanly.
// ---------------------------------------------------------------------------

export const COMPLIANT_BASELINE: ListingCopy = {
  title: "Unisex Graphic Tee, Basset Hound Nature Print",
  description: [
    "A soft, everyday tee featuring an illustrated basset hound amid wildflowers.",
    "Printed on Gildan 64000 for a comfortable fit that holds its shape wash after wash.",
    "Available in multiple sizes. Ships in 3-5 business days.",
    AI_DISCLOSURE_TEXT,
  ].join(" "),
  tags: [
    "basset hound tee",
    "dog lover gift",
    "nature print shirt",
    "graphic tee",
    "unisex tee",
    "wildflower design",
    "cottagecore style",
    "dog mom gift",
    "casual shirt",
    "nature lover tee",
    "illustrated shirt",
    "gift for her",
    "everyday tee",
  ],
};

// ---------------------------------------------------------------------------
// VIOLATING FIXTURES
// Each entry is minimally different from COMPLIANT_BASELINE.
// ---------------------------------------------------------------------------

export interface ViolatingFixture {
  /** Human-readable description of the violation being tested. */
  label: string;
  /** Rule id from CLAUDE.md (1-6, or "em-dash" for the copy-style rule). */
  ruleId: 1 | 2 | 3 | 4 | 5 | 6 | "em-dash";
  /** The substring that should appear in the ComplianceError message, or a
   *  partial match against a term known to trip the gate. */
  triggerSubstring: string;
  /** The listing copy that should cause validateCopyCompliance (or the relevant
   *  individual validator) to throw ComplianceError. */
  copy: ListingCopy;
}

export const VIOLATING_FIXTURES: ReadonlyArray<ViolatingFixture> = [
  // ---- Rule 2: AI disclosure missing ----------------------------------------
  {
    label: "Rule 2 — AI disclosure absent from description",
    ruleId: 2,
    triggerSubstring: "AI disclosure missing",
    copy: {
      ...COMPLIANT_BASELINE,
      // Strip the disclosure from the description so the verbatim gate fires.
      description:
        "A soft, everyday tee featuring an illustrated basset hound amid wildflowers. Ships in 3-5 business days.",
    },
  },

  // ---- Rule 3: Manual-creation / scarcity terms -----------------------------
  {
    label: "Rule 3 — 'handmade' in title",
    ruleId: 3,
    triggerSubstring: "handmade",
    copy: {
      ...COMPLIANT_BASELINE,
      title: "Handmade Graphic Tee, Basset Hound Nature Print",
    },
  },
  {
    label: "Rule 3 — 'hand-drawn' in description",
    ruleId: 3,
    triggerSubstring: "hand-drawn",
    copy: {
      ...COMPLIANT_BASELINE,
      description: [
        "A hand-drawn basset hound printed on a soft tee.",
        AI_DISCLOSURE_TEXT,
      ].join(" "),
    },
  },
  {
    label: "Rule 3 — 'OOAK' (one of a kind) in description",
    ruleId: 3,
    triggerSubstring: "ooak",
    copy: {
      ...COMPLIANT_BASELINE,
      description: [
        "A truly OOAK design featuring a basset hound amid wildflowers.",
        AI_DISCLOSURE_TEXT,
      ].join(" "),
    },
  },
  {
    label: "Rule 3 — 'limited edition' in description",
    ruleId: 3,
    triggerSubstring: "limited edition",
    copy: {
      ...COMPLIANT_BASELINE,
      description: [
        "This limited edition basset hound tee is available in multiple sizes.",
        AI_DISCLOSURE_TEXT,
      ].join(" "),
    },
  },
  {
    label: "Rule 3 — 'unique' in tag",
    ruleId: 3,
    triggerSubstring: "unique",
    copy: {
      ...COMPLIANT_BASELINE,
      tags: [...COMPLIANT_BASELINE.tags.slice(0, 12), "unique design"],
    },
  },

  // ---- Rule 6: Off-platform — external URL ----------------------------------
  {
    label: "Rule 6 — external URL (https://) in description",
    ruleId: 6,
    triggerSubstring: "external URL",
    copy: {
      ...COMPLIANT_BASELINE,
      description: [
        "See more designs at https://mybigetsystore.com.",
        AI_DISCLOSURE_TEXT,
      ].join(" "),
    },
  },
  {
    label: "Rule 6 — www. URL in description",
    ruleId: 6,
    triggerSubstring: "external URL",
    copy: {
      ...COMPLIANT_BASELINE,
      description: [
        "Visit www.mybigetsystore.com for more.",
        AI_DISCLOSURE_TEXT,
      ].join(" "),
    },
  },
  {
    label: "Rule 6 — social handle (@username) in description",
    ruleId: 6,
    triggerSubstring: "social handle",
    copy: {
      ...COMPLIANT_BASELINE,
      description: [
        "Follow us at @bassetandbirch for daily updates.",
        AI_DISCLOSURE_TEXT,
      ].join(" "),
    },
  },
  {
    label: "Rule 6 — 'visit our site' phrase in description",
    ruleId: 6,
    triggerSubstring: "visit our site",
    copy: {
      ...COMPLIANT_BASELINE,
      description: [
        "Visit our site for more designs.",
        AI_DISCLOSURE_TEXT,
      ].join(" "),
    },
  },
  {
    label: "Rule 6 — 'follow us on' phrase in description",
    ruleId: 6,
    triggerSubstring: "follow us on",
    copy: {
      ...COMPLIANT_BASELINE,
      description: [
        "Follow us on Instagram for the latest prints.",
        AI_DISCLOSURE_TEXT,
      ].join(" "),
    },
  },
  {
    label: "Rule 6 — 'buy direct' phrase in description",
    ruleId: 6,
    triggerSubstring: "buy direct",
    copy: {
      ...COMPLIANT_BASELINE,
      description: [
        "Buy direct from our store for wholesale pricing.",
        AI_DISCLOSURE_TEXT,
      ].join(" "),
    },
  },

  // ---- Em/en dash copy-style rule -------------------------------------------
  {
    label: "Em-dash — em dash (U+2014) in title",
    ruleId: "em-dash",
    triggerSubstring: "em/en dash",
    copy: {
      ...COMPLIANT_BASELINE,
      title: "Basset Hound Tee — Nature Print Unisex Shirt",
    },
  },
  {
    label: "Em-dash — en dash (U+2013) in description",
    ruleId: "em-dash",
    triggerSubstring: "em/en dash",
    copy: {
      ...COMPLIANT_BASELINE,
      description: [
        "Soft and comfortable – great for everyday wear.",
        AI_DISCLOSURE_TEXT,
      ].join(" "),
    },
  },
];

// ---------------------------------------------------------------------------
// MESSY INPUT for sanitizeListingCopy snapshot test
// Deliberately contains em dashes, missing AI disclosure, over-long tags,
// and duplicate tags — everything sanitizeListingCopy should fix.
// ---------------------------------------------------------------------------

export const MESSY_LISTING_COPY: ListingCopy = {
  title: "Basset Hound Graphic Tee — Nature Print",
  description:
    "Soft and comfortable – a great everyday wear option. Our tees are made to order.",
  tags: [
    "basset hound graphic tee shirt", // 26 chars — over the 20-char cap
    "dog lover gift",
    "nature print shirt",
    "Dog Lover Gift", // duplicate (case-insensitive)
    "graphic tee",
    "unisex tee",
    "wildflower design",
    "cottagecore style",
    "dog mom gift",
    "casual shirt",
    "nature lover tee",
    "illustrated shirt",
    "gift for her",
    "everyday tee", // 14th tag — over the 13-tag cap
  ],
};

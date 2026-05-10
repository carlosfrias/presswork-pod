// Etsy requires AI-generated artwork be disclosed in every listing.
// This exact sentence MUST appear verbatim in every listing description.
// Enforced by: ListingCopySchema (shared), copywriter system prompt (listing),
// and validateAiDisclosure() in packages/listing/src/compliance.ts.
export const AI_DISCLOSURE_TEXT =
  "This design was created using AI image generation tools, hand-selected and quality-reviewed by our team before printing.";

export const MAX_TAGS = 13;
export const MAX_TITLE_LEN = 140;
export const MAX_TAG_LEN = 20;

// The single Etsy shop this system is permitted to operate. Multi-shop
// operation would violate Etsy's Seller Policy (see CLAUDE.md compliance section).
export const ETSY_SHOP_NAME = "BassetAndBirch";

// Terms forbidden in listing titles, descriptions, and tags. Driven by Etsy's
// POD policy: we cannot claim manual creation, uniqueness, or scarcity for
// print-on-demand goods. Enforced by validateNoForbiddenTerms() in
// packages/listing/src/compliance.ts. Matched case-insensitively as whole words.
export const FORBIDDEN_LISTING_TERMS = [
  // Manual-creation claims
  "handmade",
  "hand-made",
  "hand made",
  "handcrafted",
  "hand-crafted",
  "hand crafted",
  "handcraft",
  "hand-drawn",
  "hand drawn",
  "handdrawn",
  "hand-painted",
  "hand painted",
  "handpainted",
  "hand-sewn",
  "hand sewn",
  "handsewn",
  "hand-stitched",
  "hand stitched",
  // Uniqueness / scarcity claims (false for POD)
  "unique",
  "one of a kind",
  "one-of-a-kind",
  "ooak",
  "limited edition",
  "limited availability",
  "limited quantity",
  "only a few left",
  "exclusive offer",
  "while supplies last",
] as const;

// Off-platform redirection — Etsy prohibits steering buyers to other channels.
// Enforced by validateNoOffPlatform() in packages/listing/src/compliance.ts.
export const EXTERNAL_URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/i;
export const SOCIAL_HANDLE_PATTERN = /(?:^|[\s.,;:!?])@[A-Za-z0-9_.]{2,}/;
export const OFF_PLATFORM_PHRASES = [
  "buy direct",
  "off etsy",
  "outside etsy",
  "outside of etsy",
  "off-platform",
  "off platform",
  "shop our website",
  "visit our site",
  "visit our website",
  "visit our shop",
  "follow us on",
  "find us on",
  "dm us",
  "message us on",
  "instagram.com",
  "facebook.com",
  "tiktok.com",
] as const;

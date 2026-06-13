// Etsy requires AI-generated artwork be disclosed in every listing.
// This exact sentence MUST appear verbatim in every listing description.
// Enforced by: ListingCopySchema (shared), copywriter system prompt (listing),
// and validateAiDisclosure() in packages/listing/src/compliance.ts.
export const AI_DISCLOSURE_TEXT =
  "This design was created using AI image generation tools, hand-selected and quality-reviewed by our team before printing.";

export const MAX_TAGS = 13;
export const MAX_TITLE_LEN = 140;
export const MAX_TAG_LEN = 20;

// Per-blueprint flat print cost (USD). Canonical source of truth shared by the
// Ledger (margin economics) and Listing (pricing floor). Update when adding new
// blueprints. Keep keys aligned with printify_blueprint_id written by Design
// (packages/design/constants.py).
export const BLUEPRINT_PRINT_COST_USD: Record<number, number> = {
  145: 10.09, // SwiftPOD Gildan 64000 t-shirt — must match printify_blueprint_id written by Design (packages/design/constants.py)
};

// Returns the flat print cost (USD) for a blueprint, or throws a clear Error
// naming the unregistered blueprint id so callers fail loudly rather than
// silently treating an unknown blueprint as free.
export function printCostForBlueprint(blueprintId: number): number {
  const cost = BLUEPRINT_PRINT_COST_USD[blueprintId];
  if (cost === undefined) {
    throw new Error(
      `No print cost configured for blueprint ID ${blueprintId}. Add it to BLUEPRINT_PRINT_COST_USD.`,
    );
  }
  return cost;
}

// Image-download guards for uploadListingImage. A hung mockup URL would
// otherwise stall the single-concurrency Etsy limiter; an oversize file would
// OOM the process via res.blob().
export const ETSY_IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;
export const ETSY_IMAGE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

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

// Etsy's accepted carrier name strings (canonical, lowercase).
// Source: Etsy Developer API carrier list. Add entries as new carriers are supported.
export const ETSY_CARRIER_NAMES: ReadonlySet<string> = new Set([
  "usps",
  "ups",
  "fedex",
  "dhl",
  "dhl-express",
  "royal-mail",
  "canada-post",
  "australia-post",
  "4px",
  "amazon-logistics-us",
  "amazon-logistics-uk",
  "ontrac",
  "lasership",
  "newgistics",
  "purolator",
  "dpd",
  "gls",
  "hermes",
  "yodel",
  "tnt",
  "aramex",
]);

// Maps raw carrier strings from Printify (and common variants) to Etsy canonical form.
// Keys are the lowercased raw strings.
const CARRIER_ALIAS_MAP: Readonly<Record<string, string>> = {
  // USPS variants
  "usps": "usps",
  "u.s.p.s.": "usps",
  "united states postal service": "usps",
  "usps first class mail": "usps",
  "usps priority mail": "usps",
  "usps ground advantage": "usps",
  // UPS variants
  "ups": "ups",
  "u.p.s.": "ups",
  "united parcel service": "ups",
  // FedEx variants
  "fedex": "fedex",
  "fed ex": "fedex",
  "federal express": "fedex",
  // DHL variants
  "dhl": "dhl",
  "dhl express": "dhl-express",
  "dhlexpress": "dhl-express",
  "dhl-express": "dhl-express",
  "dhl ecommerce": "dhl",
  // Royal Mail
  "royal mail": "royal-mail",
  "royalmail": "royal-mail",
  // Canada Post
  "canada post": "canada-post",
  "canadapost": "canada-post",
  // Australia Post
  "australia post": "australia-post",
  "australiapost": "australia-post",
  // OnTrac
  "ontrac": "ontrac",
  // LaserShip
  "lasership": "lasership",
};

/**
 * Normalizes a raw carrier string (from Printify) to the canonical Etsy carrier name.
 * Returns the canonical string if recognized; null if unknown.
 * Call this before every submitTracking() invocation.
 */
export function normalizeEtsyCarrierName(raw: string | undefined): string | null {
  if (!raw) return null;
  const lowered = raw.toLowerCase().trim();
  if (!lowered) return null;
  const mapped = CARRIER_ALIAS_MAP[lowered];
  if (mapped) return mapped;
  // Direct match against known canonical names (case-insensitive)
  if (ETSY_CARRIER_NAMES.has(lowered)) return lowered;
  return null;
}

// Off-platform redirection — Etsy prohibits steering buyers to other channels.
// Enforced by validateNoOffPlatform() in packages/listing/src/compliance.ts.

// Matches both prefixed URLs (http://, https://, www.) AND bare domains using
// a TLD allowlist. The bare-domain branch requires a non-alnum boundary on the
// left so email local-parts (me@example.com → the .com here) and version
// strings don't trip it.
// TLDs commonly used to circumvent Etsy's no-off-platform rule. The list is
// deliberately narrow (popular ccTLDs that show up in link-aggregator services
// like linktr.ee + the standard commercial TLDs) so we don't trip on legitimate
// version strings or product codes.
const _TLD_GROUP =
  "com|net|org|io|co|shop|store|me|link|ly|tk|app|page|site|online|biz|info|ee|bio|gg|to";
export const EXTERNAL_URL_PATTERN = new RegExp(
  // 1) http(s):// or www.
  `\\b(?:https?:\\/\\/|www\\.)\\S+` +
    // 2) bare domain like mystore.com or linktr.ee/x
    `|(?<![\\w@.])[A-Za-z0-9-]{2,}(?:\\.[A-Za-z0-9-]{2,}){0,2}\\.(?:${_TLD_GROUP})\\b(?:\\/\\S*)?`,
  "i"
);

// @handle must NOT be preceded by an alphanumeric (otherwise it's an email
// local part: me@example.com). The lookbehind variant is cleaner than the
// previous `(?:^|[\s.,;:!?])` form which over-restricted preceding context.
export const SOCIAL_HANDLE_PATTERN = /(?<![A-Za-z0-9])@[A-Za-z0-9_.]{2,}/;

// Phrases that signal off-platform redirection. validateNoOffPlatform() applies
// word-boundary matching (the same helper used for FORBIDDEN_LISTING_TERMS) so
// "find us on" only fires on the actual phrase, not as a substring of e.g.
// "find users on the list".
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

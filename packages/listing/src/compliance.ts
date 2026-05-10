import {
  AI_DISCLOSURE_TEXT,
  EXTERNAL_URL_PATTERN,
  FORBIDDEN_LISTING_TERMS,
  OFF_PLATFORM_PHRASES,
  SOCIAL_HANDLE_PATTERN,
} from "@presswork/shared";

/**
 * Hard-fail error for any Etsy seller-policy violation. The publisher treats
 * this exactly like a PricingFloorError: the listing never reaches Etsy.
 *
 * See ## Etsy Seller Policy Compliance in CLAUDE.md for the full rule set.
 */
export class ComplianceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComplianceError";
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

export function validateAiDisclosure(description: string): void {
  if (!description.includes(AI_DISCLOSURE_TEXT)) {
    throw new ComplianceError(
      `Etsy AI disclosure missing. Description must contain verbatim: "${AI_DISCLOSURE_TEXT}"`
    );
  }
}

export function validateNoForbiddenTerms(text: string): void {
  // The disclosure itself contains the substring "hand-selected" which is fine
  // (it describes selection, not creation). Strip the disclosure before scanning
  // so we don't match it.
  const scrubbed = text.split(AI_DISCLOSURE_TEXT).join(" ");
  const lower = scrubbed.toLowerCase();
  const hits: string[] = [];
  for (const term of FORBIDDEN_LISTING_TERMS) {
    const pattern = new RegExp(`(?:^|[^A-Za-z0-9])${escapeRegex(term)}(?=$|[^A-Za-z0-9])`, "i");
    if (pattern.test(lower)) hits.push(term);
  }
  if (hits.length > 0) {
    throw new ComplianceError(
      `Etsy POD policy violation — forbidden term(s) in listing copy: ${hits.join(", ")}`
    );
  }
}

export function validateNoOffPlatform(text: string): void {
  if (EXTERNAL_URL_PATTERN.test(text)) {
    throw new ComplianceError(
      "Etsy off-platform policy: listing copy contains an external URL"
    );
  }
  if (SOCIAL_HANDLE_PATTERN.test(text)) {
    throw new ComplianceError(
      "Etsy off-platform policy: listing copy contains a social handle (@...)"
    );
  }
  const lower = text.toLowerCase();
  const phraseHits = OFF_PLATFORM_PHRASES.filter((p) => lower.includes(p));
  if (phraseHits.length > 0) {
    throw new ComplianceError(
      `Etsy off-platform policy: listing copy contains forbidden phrase(s): ${phraseHits.join(", ")}`
    );
  }
}

export function validateProductionPartnerId(
  id: number | undefined | null
): asserts id is number {
  if (id === undefined || id === null || !Number.isFinite(id) || id <= 0) {
    throw new ComplianceError(
      "Etsy production-partner ID is missing. Register Printify as a production partner in Etsy Shop Manager and set ETSY_PRODUCTION_PARTNER_ID before publishing."
    );
  }
}

export function validateMockupProvenance(flag: boolean | undefined | null): void {
  if (flag !== true) {
    throw new ComplianceError(
      "Etsy image policy: listing images must come from Printify mockups generated from the actual design file (design_packages.mockups_from_actual_design must be true)"
    );
  }
}

/**
 * Run all copy-side gates that don't depend on Printify having been called yet.
 * Call this immediately after generating copy and before any external API calls.
 */
export function validateCopyCompliance(args: {
  title: string;
  description: string;
  tags: string[];
}): void {
  validateAiDisclosure(args.description);
  const allCopy = [args.title, args.description, ...args.tags].join("\n");
  validateNoForbiddenTerms(allCopy);
  validateNoOffPlatform(allCopy);
}

import {
  AI_DISCLOSURE_TEXT,
  EXTERNAL_URL_PATTERN,
  FORBIDDEN_LISTING_TERMS,
  OFF_PLATFORM_PHRASES,
  SOCIAL_HANDLE_PATTERN,
} from "./constants.js";

/**
 * Hard-fail error for any Etsy seller-policy violation. The publisher treats
 * this exactly like a PricingFloorError: the listing never reaches Etsy. The
 * dashboard's edit flow surfaces the message back to the operator inline.
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

// The em dash (—, U+2014) and its typographic lookalikes are a well-known
// "written by an LLM" tell. Live listing copy must never contain them. We strip
// them at every copy write/save and re-sanitize at the publish chokepoint, with
// validateNoEmDash as the final assertion. The ordinary hyphen-minus ("-") is
// intentionally left alone ("made-to-order", "hand-selected").
//   U+2012 figure dash · U+2013 en dash · U+2014 em dash · U+2015 horizontal bar
const LONG_DASH_CLASS = "‒–—―";
const LONG_DASH_TEST = new RegExp(`[${LONG_DASH_CLASS}]`);

/**
 * Replace em/en dashes (and their lookalikes) with plain, keyboard-typable
 * punctuation so copy reads as human-written and never trips the em-dash gate:
 *   - a dash between digits ("2–4 weeks") becomes a hyphen ("2-4 weeks");
 *   - any other long dash used as a clause break becomes ", ";
 * then the comma artifacts that substitution can create are tidied up.
 */
export function stripEmDashes(text: string): string {
  return text
    .replace(new RegExp(`(\\d)\\s*[${LONG_DASH_CLASS}]\\s*(\\d)`, "g"), "$1-$2")
    .replace(new RegExp(`\\s*[${LONG_DASH_CLASS}]\\s*`, "g"), ", ")
    .replace(/\s+([,.;:!?])/g, "$1") // stray space before punctuation
    .replace(/,\s*,/g, ", ") // doubled commas
    .replace(/,\s*([.;:!?])/g, "$1") // comma butted against end punctuation
    .replace(/\s{2,}/g, " ")
    .replace(/^\s*,\s*/, "") // leading comma
    .replace(/\s*,\s*$/, "") // trailing comma
    .trim();
}

/**
 * Hard gate: throws if any em/en dash survives in live copy. In normal flow it
 * never fires — every write path runs stripEmDashes first — but it guarantees
 * the invariant if a future code path ever builds copy without sanitizing.
 */
export function validateNoEmDash(text: string): void {
  if (LONG_DASH_TEST.test(text)) {
    throw new ComplianceError(
      "Listing copy contains an em/en dash (— or –). Live copy must use plain punctuation; re-save to auto-clean."
    );
  }
}

/**
 * Normalize a copy triple to the exact shape that may go live: em dashes
 * stripped from title + description, AI disclosure guaranteed present, tags
 * cleaned. Idempotent — safe to run at write time, save time, and again at the
 * publish chokepoint. Mirrors the ensureAiDisclosure / ensureValidTags pattern:
 * the LLM and the operator can write whatever they want; we own the final shape.
 */
export function sanitizeListingCopy(copy: {
  title: string;
  description: string;
  tags: string[];
}): { title: string; description: string; tags: string[] } {
  return {
    title: stripEmDashes(copy.title),
    description: ensureAiDisclosure(stripEmDashes(copy.description)),
    tags: ensureValidTags(copy.tags),
  };
}

export function validateAiDisclosure(description: string): void {
  if (!description.includes(AI_DISCLOSURE_TEXT)) {
    throw new ComplianceError(
      `Etsy AI disclosure missing. Description must contain verbatim: "${AI_DISCLOSURE_TEXT}"`
    );
  }
}

/**
 * Etsy enforces ≤20 chars per tag and ≤13 tags per listing. Returns a
 * cleaned tag array that satisfies both. Does NOT throw on input that
 * violates the limits; instead, it normalizes:
 *   - Trim whitespace; drop empties.
 *   - For each tag > 20 chars, prefer a word-boundary cut at the last
 *     space ≤20 chars. If no space exists, hard-truncate to 20.
 *   - De-duplicate (case-insensitive) since Etsy treats "Cat tee" and
 *     "cat tee" as the same tag.
 *   - Cap the array to 13.
 *
 * Same defense-in-depth pattern as ensureAiDisclosure: Claude (and the
 * operator) can write whatever they want; we own the final shape that
 * actually leaves the system. ListingCopySchema's per-tag and array-size
 * checks remain as final-invariant gates — they should never fire in
 * normal operation now.
 */
export function ensureValidTags(tags: string[]): string[] {
  const TAG_LEN_MAX = 20;
  const TAGS_MAX = 13;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    // Drop em/en dashes from tags too (→ space) so the em-dash gate can't trip
    // on a stray keyword dash; collapse the resulting whitespace.
    const trimmed = raw
      .replace(new RegExp(`[${LONG_DASH_CLASS}]`, "g"), " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (trimmed.length === 0) continue;
    let tag = trimmed;
    if (tag.length > TAG_LEN_MAX) {
      const slice = tag.slice(0, TAG_LEN_MAX);
      const lastSpace = slice.lastIndexOf(" ");
      // Use a word-boundary cut only if it leaves a meaningful tag (≥4 chars);
      // otherwise hard-truncate to keep the tag's lead-keyword intact.
      tag = lastSpace >= 4 ? slice.slice(0, lastSpace) : slice;
      tag = tag.trim();
    }
    if (tag.length === 0) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= TAGS_MAX) break;
  }
  return out;
}

/**
 * Returns the description with AI_DISCLOSURE_TEXT guaranteed to be present.
 * If the disclosure is already in the description (verbatim, anywhere), the
 * description is returned unchanged. Otherwise the disclosure is appended
 * as a final sentence with single-space separation.
 *
 * Why this exists: Etsy requires the AI disclosure to live in the listing
 * description (https://www.etsy.com/seller-handbook/article/1275449912004),
 * but enforcing a verbatim string via the LLM is unreliable — Claude often
 * paraphrases despite explicit instructions, which fails our verbatim gate
 * even though Etsy would accept the paraphrase. Centralizing the append
 * server-side eliminates that whole class of failure: Claude writes the
 * product copy, we own the disclosure.
 *
 * Both copywriter.writeCopy and the dashboard's edit actions call this
 * before the final compliance gate runs, so the verbatim check passes
 * regardless of whether Claude or the operator wrote the description.
 */
export function ensureAiDisclosure(description: string): string {
  if (description.includes(AI_DISCLOSURE_TEXT)) return description;
  const trimmed = description.trimEnd();
  const sep = trimmed.length > 0 ? " " : "";
  return `${trimmed}${sep}${AI_DISCLOSURE_TEXT}`;
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
      "Etsy off-platform policy: listing copy contains an external URL or bare domain"
    );
  }
  if (SOCIAL_HANDLE_PATTERN.test(text)) {
    throw new ComplianceError(
      "Etsy off-platform policy: listing copy contains a social handle (@...)"
    );
  }
  // Word-boundary match — substring on lowercased text used to fire on benign
  // substrings (e.g. "find us on" matching inside "find user solutions on").
  const phraseHits = OFF_PLATFORM_PHRASES.filter((p) => {
    const pattern = new RegExp(
      `(?:^|[^A-Za-z0-9])${escapeRegex(p)}(?=$|[^A-Za-z0-9])`,
      "i"
    );
    return pattern.test(text);
  });
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
 * Call this immediately after generating (or editing) copy and before any
 * external API calls or DB write that would commit the copy as approved.
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
  validateNoEmDash(allCopy);
}

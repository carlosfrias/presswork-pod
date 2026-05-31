import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { estimateAnthropicCostUsd, recordUsage } from "@presswork/shared";

/**
 * Niche generator for the Scout page's Inject form. The Python Scout agent
 * mines Etsy for trending niches; this is the manual alternative — operator
 * clicks a button (optionally with a hint like "trail running" or "Q2 gift
 * niches") and Claude returns one full brief that prefills the inject form.
 *
 * Output matches InjectBriefSchema's shape so the dashboard form can stuff
 * the values straight into its fields, the operator can tweak, and the
 * existing injectBrief server action handles persistence.
 */

const MODEL = "claude-sonnet-4-20250514";

const SYSTEM_PROMPT = `You are a print-on-demand market scout for a US-based Etsy + Printify shop
selling unisex t-shirts at a typical retail price of $26.99 (range $25.99–$34.99).

Given an optional hint from the operator, generate ONE niche brief: a
specific design space with strong selling potential on Etsy.

══════════════════════════════════════════════════════════════════════════
WHAT MAKES A GOOD NICHE
══════════════════════════════════════════════════════════════════════════
- SPECIFIC enough to design for: "vintage motorcycle racing" not "vintage things"
- BROAD enough to support multiple designs: not "1973 Ducati 750SS"
- Buyer-identity oriented: "knitting moms", "trail runners", "axe-throwing
  league members" — buyers wear the shirt because it labels them as part of
  the tribe.
- Avoid saturated commodities ("cat lover", "coffee lover", "wine mom") —
  the floor is too low to compete on at $26.99.
- Slight quirk, hobby pride, or subculture identity sells best.

When the operator provides a hint, treat it as a STARTING POINT — refine into
something specific and sellable, don't echo it verbatim. If no hint is
provided, pick a niche you haven't generated before (you have no memory
across calls; deliberately diversify across hobbies, professions, lifestyle
identities, subcultures, and seasonal moments).

══════════════════════════════════════════════════════════════════════════
OUTPUT FIELDS
══════════════════════════════════════════════════════════════════════════
• niche (string, 2–120 chars)
  Plain English label, lowercase, no quotes.
  Good: "vintage motorcycle racing", "dark fantasy mushrooms", "knitting moms"
  Bad:  "shirts", "fun stuff", "things people like"

• style_keywords (3–6 strings)
  The visual register designs in this niche should share. Combination of
  medium, line treatment, mood. Examples:
  ["screen print", "bold outlines", "muted earth tones"]
  ["watercolor", "soft washes", "cozy", "warm"]
  ["vintage halftone", "newsprint", "duotone"]

• top_tags (10–13 strings, Etsy SEO)
  Multi-word search phrases buyers actually type into Etsy. Mix subject +
  format + audience + gift-occasion. Each tag MUST be ≤ 20 characters
  (Etsy hard limit). No commas inside an individual tag.
  Examples for a "dark fantasy mushrooms" niche:
  ["mushroom tee shirt", "dark fantasy shirt", "fairycore tshirt",
   "cottagecore gift", "goth mushroom tee", "witchy shirt",
   "mushroom lover gift", "forest aesthetic", "fungi tshirt",
   "mystical mushroom", "dark academia tee", "occult shirt"]

• color_palette (3–5 hex strings)
  Dominant colors for designs in this niche. Evocative, not safe greys.
  Hex format only ("#xxxxxx"). Pick palettes that print well on dark AND
  light tee colors.

• price_target_usd (number)
  25.99–34.99 range. Default 26.99 for everyday niches; 29.99–34.99 for
  hobby-pride / gift / specialty niches where buyers expect to spend more.

══════════════════════════════════════════════════════════════════════════
COMPLIANCE — NON-NEGOTIABLE
══════════════════════════════════════════════════════════════════════════
• NO artist names, brand names, athlete names, team names, named characters
  from books / film / TV / games, song lyrics, or trademarked phrases.
  ("Taylor Swift fan", "Marvel-style", "Pokemon-inspired" → REJECT all.)
• NO religious scripture references.
• NO political affiliation or candidate names.
• Generic identity terms are fine ("trail runner", "knitting mom",
  "axe-thrower", "metal head", "yoga teacher").

══════════════════════════════════════════════════════════════════════════
RESPONSE
══════════════════════════════════════════════════════════════════════════
Respond ONLY with valid JSON, no prose, no code fences:
{
  "niche": str,
  "style_keywords": [str, ...],
  "top_tags": [str, ...],
  "color_palette": [str, ...],
  "price_target_usd": number
}`;

export class GenerateNicheError extends Error {
  constructor(message: string, public readonly raw?: string) {
    super(message);
    this.name = "GenerateNicheError";
  }
}

export interface GeneratedNicheBrief {
  niche: string;
  style_keywords: string[];
  top_tags: string[];
  color_palette: string[];
  price_target_usd: number;
}

const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;
const MAX_TAG_LENGTH = 20;
const MAX_TAGS = 13;

/**
 * Ask Claude for a single niche brief, optionally steered by an operator hint.
 *
 * @param hint  Optional free-form hint. Trimmed; empty becomes null.
 * @returns     A validated brief whose shape matches the dashboard's
 *              InjectBriefSchema so the result can flow straight into the
 *              Inject form fields.
 */
export async function generateNicheBrief(
  hint: string | null,
): Promise<GeneratedNicheBrief> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new GenerateNicheError("ANTHROPIC_API_KEY is not set");
  }

  const client = new Anthropic({ apiKey });

  const trimmedHint = hint?.trim() || null;
  const userPayload = JSON.stringify(
    { hint: trimmedHint, request: "generate one niche brief" },
    null,
    2,
  );

  const response = await client.beta.promptCaching.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userPayload }],
    betas: ["prompt-caching-2024-07-31"],
  });

  const usage = response.usage as
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      }
    | undefined;
  if (usage) {
    void recordUsage({
      agent: "scout",
      provider: "anthropic",
      operation: "generate_niche",
      cost_usd: estimateAnthropicCostUsd(
        MODEL,
        usage.input_tokens ?? 0,
        usage.output_tokens ?? 0,
        usage.cache_read_input_tokens ?? 0,
        usage.cache_creation_input_tokens ?? 0,
      ),
      input_tokens: usage.input_tokens ?? null,
      output_tokens: usage.output_tokens ?? null,
      metadata: {
        model: MODEL,
        hint: trimmedHint,
        source: "dashboard_generate",
      },
    });
  }

  const firstBlock = response.content[0];
  if (!firstBlock || firstBlock.type !== "text") {
    throw new GenerateNicheError("Claude returned no text content");
  }

  let raw = firstBlock.text.trim();
  if (raw.startsWith("```")) {
    raw = raw.split("```", 2)[1] ?? raw;
    if (raw.startsWith("json")) raw = raw.slice(4);
    raw = raw.trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GenerateNicheError("Claude response was not valid JSON", raw);
  }

  return validate(parsed, raw);
}

function validate(parsed: unknown, raw: string): GeneratedNicheBrief {
  if (!parsed || typeof parsed !== "object") {
    throw new GenerateNicheError("Claude response is not an object", raw);
  }
  const p = parsed as Record<string, unknown>;

  const niche = typeof p.niche === "string" ? p.niche.trim() : "";
  if (niche.length < 2 || niche.length > 120) {
    throw new GenerateNicheError(
      `niche must be 2–120 chars, got ${niche.length}`,
      raw,
    );
  }

  const style_keywords = toStringArray(p.style_keywords);
  if (style_keywords.length < 3 || style_keywords.length > 6) {
    throw new GenerateNicheError(
      `style_keywords must have 3–6 entries, got ${style_keywords.length}`,
      raw,
    );
  }

  const top_tags = toStringArray(p.top_tags);
  if (top_tags.length < 10 || top_tags.length > MAX_TAGS) {
    throw new GenerateNicheError(
      `top_tags must have 10–${MAX_TAGS} entries, got ${top_tags.length}`,
      raw,
    );
  }
  const overlongTag = top_tags.find((t) => t.length > MAX_TAG_LENGTH);
  if (overlongTag) {
    throw new GenerateNicheError(
      `tag "${overlongTag}" exceeds Etsy's ${MAX_TAG_LENGTH}-char limit`,
      raw,
    );
  }

  const color_palette = toStringArray(p.color_palette);
  if (color_palette.length < 3 || color_palette.length > 5) {
    throw new GenerateNicheError(
      `color_palette must have 3–5 entries, got ${color_palette.length}`,
      raw,
    );
  }
  const badHex = color_palette.find((c) => !HEX_PATTERN.test(c));
  if (badHex) {
    throw new GenerateNicheError(
      `color "${badHex}" is not a valid #rrggbb hex`,
      raw,
    );
  }

  const price = Number(p.price_target_usd);
  if (!Number.isFinite(price) || price < 25.99 || price > 34.99) {
    throw new GenerateNicheError(
      `price_target_usd must be 25.99–34.99, got ${p.price_target_usd}`,
      raw,
    );
  }

  return {
    niche,
    style_keywords,
    top_tags,
    color_palette,
    price_target_usd: Math.round(price * 100) / 100,
  };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
}

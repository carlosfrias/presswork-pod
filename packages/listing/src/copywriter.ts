import Anthropic from "@anthropic-ai/sdk";
import {
  type TrendBrief,
  type DesignPackage,
  type ListingCopy,
  ListingCopySchema,
  getSettings,
} from "@presswork/shared";
import { AI_DISCLOSURE_TEXT } from "@presswork/shared";

export class CopywriterError extends Error {
  constructor(
    message: string,
    public readonly issues: unknown
  ) {
    super(message);
    this.name = "CopywriterError";
  }
}

const SYSTEM_PROMPT = `You are an expert Etsy SEO copywriter for print-on-demand products.
Given a design brief, produce optimized Etsy listing copy.
Respond ONLY with valid JSON:
{
  "title": string,       // max 140 chars, lead with primary keyword
  "description": string, // 150-300 words, conversational, keyword-rich
  "tags": string[]       // exactly 13 tags, mix of exact-match and long-tail
}
Do not use all-caps. Do not use excessive punctuation. Sound human.

ETSY SELLER POLICY — these rules are non-negotiable. Listings that violate any of
them will be rejected before publishing.

1. AI disclosure (required). The description MUST end with this exact sentence,
   verbatim, as the final sentence:
   "${AI_DISCLOSURE_TEXT}"

2. No manual-creation language. These are print-on-demand products produced by a
   third-party fulfillment partner. NEVER use any of: "handmade", "hand made",
   "hand-made", "handcrafted", "hand-crafted", "hand-drawn", "hand-painted",
   "hand-sewn", "hand-stitched", or any variation that implies the product was
   created by hand.

3. No false uniqueness or scarcity. NEVER use "unique", "one of a kind",
   "one-of-a-kind", "OOAK", "limited edition", "limited availability",
   "limited quantity", "exclusive offer", "only a few left", or "while supplies
   last". POD inventory is not finite, and identical items can be reordered.

4. No off-Etsy redirection. NEVER include URLs, social-media handles (e.g.
   @username), domain names (instagram.com, facebook.com, etc.), or phrasing
   that asks buyers to purchase, contact, or follow you anywhere outside Etsy.
   No "DM us", "follow us on", "visit our website", "buy direct", etc.

Write copy that is engaging and SEO-rich while staying inside these rules.`;

export async function writeCopy(
  brief: TrendBrief,
  design: DesignPackage
): Promise<ListingCopy> {
  const { ANTHROPIC_API_KEY } = getSettings();
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const userMessage = JSON.stringify({
    niche: brief.niche,
    style_keywords: brief.style_keywords,
    top_tags: brief.top_tags,
    color_palette: brief.color_palette,
    price_target_usd: brief.price_target_usd,
    blueprint_id: design.printify_blueprint_id,
    variant_count: design.printify_variant_ids?.length ?? 0,
  });

  const response = await client.beta.promptCaching.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userMessage }],
    betas: ["prompt-caching-2024-07-31"],
  });

  const firstBlock = response.content[0];
  if (!firstBlock || firstBlock.type !== "text") {
    throw new CopywriterError("Claude returned no text content", null);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(firstBlock.text);
  } catch {
    throw new CopywriterError("Claude response was not valid JSON", firstBlock.text);
  }

  const result = ListingCopySchema.safeParse(parsed);
  if (!result.success) {
    throw new CopywriterError("Claude response failed validation", result.error.issues);
  }

  return result.data;
}

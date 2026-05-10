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

The description MUST contain this exact sentence verbatim:
"${AI_DISCLOSURE_TEXT}"`;

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

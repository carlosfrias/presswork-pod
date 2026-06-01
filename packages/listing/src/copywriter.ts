import Anthropic from "@anthropic-ai/sdk";
import {
  type TrendBrief,
  type DesignPackage,
  type ListingCopy,
  ListingCopySchema,
  ensureAiDisclosure,
  ensureValidTags,
  stripEmDashes,
  getSettings,
  estimateAnthropicCostUsd,
  recordUsage,
} from "@presswork/shared";

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
VOICE — write like a real person, not an AI. This copy must NOT read as
machine-generated:
- NEVER use an em dash (—) or en dash (–). This is the single most important
  stylistic rule. Use commas, periods, or parentheses instead. Only the plain
  hyphen (-) is allowed, and only inside words like "made-to-order".
- Avoid LLM tells and filler: "elevate", "dive in", "in today's world", "look
  no further", "whether you're a ... or a ...", "perfect for those who",
  "nestled", "boasts", "a testament to", "unleash", "curated", "game-changer".
- Vary sentence length and opening structure. Mix short, punchy lines with
  longer ones. Do not start every sentence the same way.
- Skip breathless hype and rule-of-three lists written for their own sake. Be
  concrete about the design and who would actually wear it.
- Do not use all-caps. Do not use excessive punctuation. Plain, warm,
  confident English.

DO NOT mention AI, generative tools, machine learning, "AI-generated", or how the
design was made. Etsy requires an AI disclosure in the description, but we append
it server-side from a fixed verbatim string AFTER your response. If you mention AI,
the description will end up with two competing disclosures (yours + ours) and look
redundant. Just write the product copy.

ETSY SELLER POLICY — these rules are non-negotiable. Listings that violate any of
them will be rejected before publishing.

1. No manual-creation language. These are print-on-demand products produced by a
   third-party fulfillment partner. NEVER use any of: "handmade", "hand made",
   "hand-made", "handcrafted", "hand-crafted", "hand-drawn", "hand-painted",
   "hand-sewn", "hand-stitched", or any variation that implies the product was
   created by hand.

2. No false uniqueness or scarcity. NEVER use "unique", "one of a kind",
   "one-of-a-kind", "OOAK", "limited edition", "limited availability",
   "limited quantity", "exclusive offer", "only a few left", or "while supplies
   last". POD inventory is not finite, and identical items can be reordered.

3. No off-Etsy redirection. NEVER include URLs, social-media handles (e.g.
   @username), domain names (instagram.com, facebook.com, etc.), or phrasing
   that asks buyers to purchase, contact, or follow you anywhere outside Etsy.
   No "DM us", "follow us on", "visit our website", "buy direct", etc.

Write copy that is engaging and SEO-rich while staying inside these rules.

VISION INPUT
When an image of the approved design is included in this message, use it as
the primary source of truth for what the product looks like. Describe what you
actually see — the subject, style, mood, and key visual details. Ground the
title, description, and tags in the real image, not in the brief alone. The
brief data is secondary context for niche, SEO signals, and pricing only.`;

// Copy is always written by the best, latest Claude model — there is
// deliberately no per-run / runtime-flag model selection for copy generation.
// Bump this one constant when a newer flagship ships.
const COPYWRITER_MODEL = "claude-opus-4-8";

/**
 * Rewrite a Supabase Storage object URL to the image transform endpoint so
 * Claude receives a viewport-sized JPEG instead of the full 4500×5400 print
 * PNG. Claude Vision doesn't need print resolution to understand composition —
 * 1024px is more than sufficient, and the reduced payload is ~50–200× smaller.
 *
 * Uses `resize=contain` (not `cover`) to preserve the full design without
 * cropping. Non-Supabase URLs (Printify CDN, external) are returned unchanged.
 * On Supabase free tier the render endpoint returns the original file, so this
 * degrades gracefully without errors.
 */
function toVisionUrl(url: string | null): string | null {
  if (!url) return null;
  if (!url.includes("/storage/v1/object/public/")) return url;
  const u = new URL(url);
  u.pathname = u.pathname.replace(
    "/storage/v1/object/public/",
    "/storage/v1/render/image/public/",
  );
  u.searchParams.set("width", "1024");
  u.searchParams.set("quality", "85");
  u.searchParams.set("resize", "contain");
  return u.toString();
}

export async function writeCopy(
  brief: TrendBrief,
  design: DesignPackage,
  options: { imageUrl?: string | null } = {}
): Promise<ListingCopy> {
  const model = COPYWRITER_MODEL;
  const rawImageUrl = options.imageUrl ?? design.image_url ?? null;
  // Downscale to 1024px before sending to Claude — print PNGs are 4500×5400
  // and Claude Vision doesn't need that resolution to read a t-shirt design.
  const imageUrl = toVisionUrl(rawImageUrl);

  const { ANTHROPIC_API_KEY } = getSettings();
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const briefPayload = JSON.stringify({
    niche: brief.niche,
    style_keywords: brief.style_keywords,
    top_tags: brief.top_tags,
    color_palette: brief.color_palette,
    price_target_usd: brief.price_target_usd,
    blueprint_id: design.printify_blueprint_id,
    variant_count: design.printify_variant_ids?.length ?? 0,
  });

  // When an image is available, send it first so Claude anchors on the actual
  // approved design before reading the brief. Vision models process image-first
  // ordering with higher fidelity to the visual than text-first.
  // URL-source image blocks are supported by the API but the local SDK type
  // definition lags behind — cast through the content union the same way
  // build-prompt.ts does for reference images.
  const userContent = (
    imageUrl
      ? [
          {
            type: "image" as const,
            source: { type: "url" as const, url: imageUrl },
          },
          { type: "text" as const, text: briefPayload },
        ]
      : briefPayload
  ) as Anthropic.MessageParam["content"];

  const response = await client.beta.promptCaching.messages.create({
    model,
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userContent }],
    betas: ["prompt-caching-2024-07-31"],
  });

  // Best-effort consumption log for the dashboard. recordUsage is fire-and-forget.
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
      agent: "listing",
      provider: "anthropic",
      operation: "copywriter",
      cost_usd: estimateAnthropicCostUsd(
        model,
        usage.input_tokens ?? 0,
        usage.output_tokens ?? 0,
        usage.cache_read_input_tokens ?? 0,
        usage.cache_creation_input_tokens ?? 0,
      ),
      input_tokens: usage.input_tokens ?? null,
      output_tokens: usage.output_tokens ?? null,
      metadata: { model, niche: brief.niche, vision: imageUrl != null },
    });
  }

  const firstBlock = response.content[0];
  if (!firstBlock || firstBlock.type !== "text") {
    throw new CopywriterError("Claude returned no text content", null);
  }

  // Strip a leading ```json (or ```) fence and trailing ``` if Claude
  // wrapped the JSON in markdown despite the system prompt asking for raw
  // JSON. Common failure mode that's far cheaper to handle here than to
  // retry the whole call. Falls through unchanged if there's no fence.
  const stripped = firstBlock.text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    // Include a head excerpt of the raw response in the message so the agent
    // log captures what Claude actually said. The full text is also passed as
    // `issues` for any caller that wants the complete payload.
    const excerpt = firstBlock.text.slice(0, 400).replace(/\s+/g, " ");
    throw new CopywriterError(
      `Claude response was not valid JSON. Excerpt: ${excerpt}`,
      firstBlock.text
    );
  }

  // Auto-fix common Claude misses server-side, same defense-in-depth pattern
  // as the dashboard save actions: the LLM can write whatever, we own the
  // shape that actually reaches Etsy.
  //   - title/description: strip em/en dashes (no AI-tell punctuation goes live).
  //   - description: ensure verbatim AI_DISCLOSURE_TEXT is present (Etsy
  //     requires the disclosure; we own the wording). Strip dashes BEFORE
  //     appending the disclosure so the verbatim disclosure stays intact.
  //   - tags: trim each to ≤20 chars (word-boundary aware), cap to 13,
  //     drop dups + empties. Etsy enforces both limits hard.
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.title === "string") {
      obj.title = stripEmDashes(obj.title);
    }
    if (typeof obj.description === "string") {
      obj.description = ensureAiDisclosure(stripEmDashes(obj.description));
    }
    if (Array.isArray(obj.tags)) {
      obj.tags = ensureValidTags(obj.tags as string[]);
    }
  }

  const result = ListingCopySchema.safeParse(parsed);
  if (!result.success) {
    // Inline a compact summary of the Zod issues so the agent log + the
    // listings.error_message column carry actionable detail. The full issue
    // tree is still passed as `issues` for callers that want it. Common
    // failures the operator sees here:
    //   - missing AI_DISCLOSURE_TEXT in description
    //   - title > 140 chars
    //   - title is all-caps
    //   - tags array > 13 entries or any tag > 20 chars
    const summary = result.error.issues
      .map((i) => {
        const path = i.path.length > 0 ? i.path.join(".") : "(root)";
        return `${path}: ${i.message}`;
      })
      .join("; ");
    throw new CopywriterError(
      `Claude response failed validation — ${summary}`,
      result.error.issues
    );
  }

  return result.data;
}

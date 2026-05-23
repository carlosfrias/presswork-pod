import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { estimateAnthropicCostUsd, recordUsage } from "@presswork/shared";
import { getStyle, type StyleId } from "@/lib/styles/catalog";

/**
 * Builder's job: take an operator seed (free-form English, may be anywhere from
 * "bulldog trashman" to a full description) and Scout's trend signals, and
 * produce a fleshed-out image description for Design to render.
 *
 * Operator-named fields are LOCKED. Builder only fills gaps. Scout signals are
 * priors for what to fill in — never overrides for what the operator said.
 *
 * Output is natural English, 2-4 sentences. Design adds print-readiness on top.
 */

const MODEL = "claude-sonnet-4-20250514";

const SYSTEM_PROMPT = `You are a print-on-demand creative director. Given a creative seed from the
operator and (optional) trend signals from the Scout agent, produce ONE
fleshed-out image description for the Design agent to render.

══════════════════════════════════════════════════════════════════════════
RULE 1 — THE OPERATOR'S SEED IS AUTHORITATIVE
══════════════════════════════════════════════════════════════════════════
Parse the seed for what the operator has named. Anything they named is LOCKED.
Your job is to fill in only the GAPS. The fields you may need to fill:

  • SUBJECT — the focal character/object (e.g. "bulldog trashman")
  • STYLE / MEDIUM — screen print, oil painting, watercolor, papercut, marker,
    pixel art, ink wash, etc.
  • COLOR PALETTE — 3-5 colors, named (e.g. "mustard, olive, cream") or hex
  • SCENE / ACTION — what the subject is DOING. Pose, prop, gesture, context.

If the operator named the style, you do NOT pick a different one. If they
named a palette, you keep those colors. If they wrote a full scene, you do
not invent a different scene — you may add small concrete details to make it
render-ready.

══════════════════════════════════════════════════════════════════════════
RULE 2 — REFERENCE IMAGE(S) (when provided) ARE VISUAL ANCHORS
══════════════════════════════════════════════════════════════════════════
The operator may attach up to 3 reference images. Each is a visual anchor:
composition, pose, lighting, style register, palette — pulled from a specific
example they want the final design to honor.

When references are present:
  • LOOK at every image. Describe what you actually see, not what you imagine.
  • Capture concrete details: pose (three-quarter, profile, frontal), where
    the subject sits in the frame, lighting direction, depth, era cues,
    signature props or garments, background simplicity. These are the load-
    bearing parts of "match this."

SINGLE REFERENCE (one image):
  • Treat it as the primary anchor for both composition AND palette unless
    the operator named a different palette in the seed.

MULTIPLE REFERENCES (2 or 3 images):
  • Treat them as COMPLEMENTARY anchors, not competing copies. Read the seed
    to decide which image owns which dimension. Common splits:
      - image 1 = composition anchor (the painting / pose / framing)
      - image 2 = style register anchor (the medium / line work / shading)
      - image 3 = palette / mood anchor (the colors / atmosphere)
  • If the seed doesn't differentiate, default to: image 1 carries
    composition, image 2 carries style register, image 3 carries palette.
  • Name the split explicitly in your description so Design knows the intent:
    e.g. "matching the composition of [image 1] in the style register of
    [image 2] with the muted earth-tone palette suggested by [image 3]."
  • DO NOT average the images into a mush. Each one anchors one dimension.

Apply the seed as a TRANSFORMATION on top of the reference(s):
  • Seed "match this" / "as-is" / no transformation language → faithful
    composite of the references, partitioned by dimension as above.
  • Seed names a subject swap ("but make it a bulldog") → keep the
    references' composition / style / palette, swap the subject.
  • Seed names a style swap ("but as a screen print") → keep composition
    (image 1) and palette (image 3 if present), drop the style anchor in
    favor of the seed's named style.
  • Seed and reference in direct conflict on the same dimension → the SEED
    wins. Note the conflict implicitly in your description.

If no reference images are present, skip this rule.

══════════════════════════════════════════════════════════════════════════
RULE 2.5 — STYLE LOCK (when present, second only to the seed)
══════════════════════════════════════════════════════════════════════════
When the input contains a non-null \`style_lock\` field, that style is LOCKED.
The directive describes medium, line, palette, and composition in concrete
terms — fold every aspect of it into your description. Drop any conflicting
style language from the seed, references, or Scout signals (the seed still
wins on SUBJECT, but the style is now the chip's, not the seed's).

If style_lock is null, this rule is skipped and Scout signals continue to
fill any style gap the seed didn't name (Rule 3).

══════════════════════════════════════════════════════════════════════════
RULE 2.7 — CREATIVE HOOKS (when present, LOCKED supplemental directives)
══════════════════════════════════════════════════════════════════════════
When the input contains a non-null \`creative_hooks\` object, treat each
present field as a LOCKED constraint — exactly as binding as what the
operator named in the seed:

  \`art_reference\`: A named art movement, artist, visual style, or cultural
    crossover (e.g. "Andy Warhol banana print style", "ukiyo-e woodblock",
    "Street Fighter Hadouken crouch pose"). This is LOCKED as the stylistic
    or compositional anchor. Fold it into your description as specifically
    as the example shows — name the technique, composition, palette register,
    or cultural touchstone it implies.

  \`text_in_design\`: Exact copy that must appear physically in the final
    image as lettering or typography. This is LOCKED verbatim — do not
    paraphrase or omit it. Specify the text and suggest a period-appropriate
    typeface if it helps (e.g. "in a rounded 70s serif" or "in bold Gothic
    condensed"), but the literal text is non-negotiable.

  \`pose_action\`: The specific physical action, pose, or emotional beat for
    the subject (e.g. "pouring steamed milk with focused concentration",
    "raising one webbed hand in triumph", "crouched with arms extended in a
    power stance"). This is LOCKED — do not substitute a different action.

Omitted or null fields in creative_hooks are simply skipped; the gaps fall
through to the seed, references, and Scout signals as usual.

══════════════════════════════════════════════════════════════════════════
RULE 3 — SCOUT SIGNALS ARE PRIORS FOR THE GAPS, NEVER OVERRIDES
══════════════════════════════════════════════════════════════════════════
When you have to FILL a gap and Scout provided relevant signals, lean on
them. Style_keywords ["screen print", "bold outlines"] → pick screen print
when the operator didn't name a style. Color_palette ["#5a7d6a", "#c0a06b"]
→ adopt those colors when the operator didn't name any. Top_tags hint at
the kind of subject context that sells in this niche.

Scout signals are guidance for the niche, not for THIS specific image —
when in tension with the seed's or reference's clear intent, the more
specific signal wins (seed > reference > scout).

══════════════════════════════════════════════════════════════════════════
RULE 4 — FILL ONE SPECIFIC, CONCRETE SCENE
══════════════════════════════════════════════════════════════════════════
If the operator didn't name a scene/action AND no reference image fixes
the composition, INVENT ONE. Pick a single concrete moment: "lifting a
battered trash can over one shoulder", "riding on the back of a garbage
truck", "hauling a sack and squinting at the sun". Not "doing trashman
stuff" — pick the specific action.

For animal-as-character subjects: state the head is ANIMAL-shaped with no
human expressiveness. Animals shouldn't morph into anthropomorphic faces.

══════════════════════════════════════════════════════════════════════════
RULE 5 — OUTPUT FORMAT
══════════════════════════════════════════════════════════════════════════
2-4 sentences of natural English. Concrete, specific, render-ready.
Include: subject + style/medium + palette description + scene/composition.

When a reference image was provided, name its composition anchor explicitly
(e.g. "Vermeer's Girl with a Pearl Earring pose: three-quarter, head turned
toward the viewer, soft directional light from the upper left, deep shadow
on the right side of the face") so Design has the concrete pattern to render.

Do NOT include print-readiness directives — no "centered", "generous border",
"no scenery", "transparent background". Design adds those. Your job is
creative direction only.

══════════════════════════════════════════════════════════════════════════
WORKED EXAMPLES
══════════════════════════════════════════════════════════════════════════
SEED: "bulldog trashman"
SCOUT: niche="animals in working situations", style_keywords=["screen print", "bold outlines"], color_palette=["#c8a532", "#6b7a3a", "#f4ead0"]
→ {"description": "A flat-color screen print of a bulldog in a navy worker's jumpsuit, hauling a battered metal trash can over one shoulder, mid-stride beside a garbage truck. Mustard, olive, and cream palette (#c8a532, #6b7a3a, #f4ead0) with bold outlines, no shading. The bulldog's head stays fully canine — jowls, no human expression, just a determined level gaze and slightly flopping ears."}

SEED: "fox barista, watercolor, peach palette"
SCOUT: niche="animals coffee shop", style_keywords=["soft", "cozy"], color_palette=null
→ {"description": "A loose watercolor of a small fox barista behind a wooden coffee bar, holding a steaming ceramic cup with both front paws. Peach, warm cream, and soft brown washes with visible paper texture and gentle bleeding edges. The fox face stays naturally vulpine — narrow muzzle, attentive ears forward, no anthropomorphic smile, just a focused steady stare."}

SEED: "frog knight"
SCOUT: null (manual entry, niche="original design")
→ {"description": "A standing frog knight in plate armor, sword tip resting on the ground in front of him, helmet held under one arm. Muted moss-green, polished steel, and dull ochre palette rendered as a flat-color ink illustration with crisp dark linework. Calm, dutiful posture with a level forward gaze; the frog face stays fully amphibian — wide bulging eyes, broad mouth, no human expressiveness."}

SEED: "knit-mom shirt, screen print, two-color, navy + cream — woman holding a ball of yarn"
SCOUT: niche="knitting mom gifts", style_keywords=["bold", "minimal"]
→ {"description": "A two-color screen print of a woman with a relaxed smile holding a generous ball of yarn against her chest, with a single knitting needle tucked through the side. Navy and cream only, flat solid fills with bold outlines, no shading or halftones. Front-facing pose, shoulders square, hair tied back."}

SEED: "but a tabby cat instead of the girl"
REFERENCE: [an image of Vermeer's Girl with a Pearl Earring]
SCOUT: niche="cat lover gifts", style_keywords=["fine art", "classical"], color_palette=null
→ {"description": "A faithful recreation of Vermeer's Girl with a Pearl Earring composition, but with a tabby cat in place of the girl: three-quarter pose, head turned toward the viewer, soft directional light from the upper left, deep shadow falling on the right side of the face, a single pearl earring visible in one ear, dark featureless background. Painterly chiaroscuro with Vermeer's restrained warm palette — muted ochre, ultramarine blue, ivory, deep umber — visible brushwork preserved. The cat face stays fully feline: forward-set eyes, distinct muzzle, no human expressiveness, just a calm steady stare meeting the viewer."}

══════════════════════════════════════════════════════════════════════════
RESPONSE
══════════════════════════════════════════════════════════════════════════
Respond ONLY with valid JSON matching this schema:
{
  "description": str  // the fleshed-out image description, 2-4 sentences
}`;

export class BuildPromptError extends Error {
  constructor(message: string, public readonly raw?: string) {
    super(message);
    this.name = "BuildPromptError";
  }
}

/**
 * Heuristic: was this Anthropic 400 caused by an unfetchable reference URL?
 * The SDK surfaces these as APIError with status 400. The message body varies
 * (mentions "image", "url", "could not fetch", "unsupported media type"),
 * so match loosely on common substrings. False positives only matter when
 * references were attached — we gate the rephrasing on that upstream.
 */
function isImageFetchError(err: unknown): boolean {
  if (!(err instanceof Anthropic.APIError) || err.status !== 400) return false;
  const message = (err.message ?? "").toLowerCase();
  return (
    message.includes("image") ||
    message.includes("could not fetch") ||
    message.includes("url") ||
    message.includes("media type")
  );
}

export interface ScoutSignals {
  niche: string;
  style_keywords?: string[] | null;
  top_tags?: string[] | null;
  color_palette?: string[] | null;
}

/** Optional locked supplemental directives from the operator. Each present
 *  field is treated as authoritative as something named in the seed. */
export interface CreativeHooks {
  /** Named art movement, artist, or cultural crossover to anchor style/composition. */
  artReference?: string | null;
  /** Exact text that must appear physically as lettering in the final image. */
  textInDesign?: string | null;
  /** Specific physical action, pose, or emotional beat for the subject. */
  poseAction?: string | null;
}

/**
 * Build an image description from an operator seed and (optional) Scout signals.
 *
 * @param seed                Free-form operator text. May be a bare subject
 *                            ("bulldog trashman") or a fuller description with
 *                            style, palette, scene named inline. Anything named
 *                            is locked.
 * @param scout               Optional trend signals from the upstream brief.
 *                            Used as priors for whatever gaps the seed didn't
 *                            fill. Pass null for manual entries that don't sit
 *                            under a Scout brief.
 * @param referenceImageUrls  Optional list of publicly-fetchable URLs (max 3,
 *                            enforced upstream). When set, each is sent to
 *                            Claude as a vision input — the system prompt
 *                            partitions them by dimension (composition / style
 *                            / palette). Not persisted; consumed at build
 *                            time only.
 * @param styleId             Optional style chip selection (locked style directive).
 * @param hooks               Optional creative hooks (art reference, text in design,
 *                            pose/action). Each present field is LOCKED — treated
 *                            as authoritative as the operator seed.
 * @returns                   The fleshed-out image description, ready to write
 *                            to trend_briefs.image_description.
 */
export async function buildPromptDescription(
  seed: string,
  scout: ScoutSignals | null,
  referenceImageUrls: string[] | null = null,
  styleId: StyleId | null = null,
  hooks: CreativeHooks | null = null,
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new BuildPromptError("ANTHROPIC_API_KEY is not set");
  }

  const client = new Anthropic({ apiKey });

  const hasReferences = Boolean(referenceImageUrls && referenceImageUrls.length > 0);
  // When the operator picks a style chip we lift the directive out of the
  // catalog and hand it to Claude as a dedicated `style_lock` field. The
  // system prompt's Rule 1 ("operator's seed is authoritative") already
  // covers "anything the operator named is locked" — surfacing the directive
  // as a separate JSON field makes it impossible for Claude to read it as
  // narrative seed text and dilute it.
  const style = getStyle(styleId);

  const textPayload = JSON.stringify(
    {
      seed: seed.trim(),
      style_lock: style
        ? {
            name: style.label,
            directive: style.directive,
            instructions:
              "This style is LOCKED. Every line of the directive must be honored " +
              "in your description. Any conflicting style language in the seed or " +
              "Scout signals is dropped. The directive describes medium, line, " +
              "palette, composition — translate all of it into your output.",
          }
        : null,
      creative_hooks:
        hooks && (hooks.artReference || hooks.textInDesign || hooks.poseAction)
          ? {
              ...(hooks.artReference ? { art_reference: hooks.artReference } : {}),
              ...(hooks.textInDesign ? { text_in_design: hooks.textInDesign } : {}),
              ...(hooks.poseAction ? { pose_action: hooks.poseAction } : {}),
            }
          : null,
      scout_brief: scout
        ? {
            niche: scout.niche,
            style_keywords: scout.style_keywords ?? null,
            top_tags: scout.top_tags ?? null,
            color_palette: scout.color_palette ?? null,
          }
        : null,
      reference_image_count: hasReferences ? referenceImageUrls!.length : 0,
    },
    null,
    2,
  );

  // Image-first ordering lets Claude anchor on the visual references before
  // reading the seed — improves composition fidelity over text-then-image.
  // Multiple images keep their input order: image 1 first, image 2 next, etc.
  // The system prompt assigns dimension by position when the seed is silent.
  // Cast through the SDK's content union: URL-source image blocks are
  // supported by the API but the local SDK type may lag the API release.
  const userContent = hasReferences
    ? ([
        ...referenceImageUrls!.map((url) => ({
          type: "image" as const,
          source: { type: "url" as const, url },
        })),
        { type: "text" as const, text: textPayload },
      ] as Anthropic.MessageParam["content"])
    : textPayload;

  let response;
  try {
    response = await client.beta.promptCaching.messages.create({
      model: MODEL,
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
  } catch (err) {
    // Anthropic returns 400 when a reference URL can't be fetched as an
    // image (e.g., share.google links that 302 to HTML, Pinterest pages,
    // Google Search results, anything behind login). Reword so the operator
    // knows it's their URL, not the agent.
    if (hasReferences && isImageFetchError(err)) {
      throw new BuildPromptError(
        "Reference URL did not resolve to an image. Use a direct image link " +
          "(.jpg / .png / .webp). On a webpage, right-click the image and " +
          "choose 'Copy image address' — share links and Google/Pinterest " +
          "page URLs won't work because they return HTML, not image bytes.",
      );
    }
    throw err;
  }

  // Best-effort consumption log so Builder shows up in the LLM-spend dashboard
  // alongside Scout's analyzer and Listing's copywriter. Fire-and-forget.
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
      agent: "builder",
      provider: "anthropic",
      operation: "build_prompt",
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
        niche: scout?.niche ?? null,
        manual: scout === null,
        reference_image_count: hasReferences ? referenceImageUrls!.length : 0,
        style: style?.id ?? null,
      },
    });
  }

  const firstBlock = response.content[0];
  if (!firstBlock || firstBlock.type !== "text") {
    throw new BuildPromptError("Claude returned no text content");
  }

  let raw = firstBlock.text.trim();
  // Strip optional ```json fences Claude sometimes emits.
  if (raw.startsWith("```")) {
    raw = raw.split("```", 2)[1] ?? raw;
    if (raw.startsWith("json")) raw = raw.slice(4);
    raw = raw.trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BuildPromptError("Claude response was not valid JSON", raw);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { description?: unknown }).description !== "string"
  ) {
    throw new BuildPromptError("Claude response missing 'description' string", raw);
  }
  const description = (parsed as { description: string }).description.trim();
  if (description.length < 10) {
    throw new BuildPromptError(`Description too short: ${description.length} chars`, raw);
  }
  return description;
}

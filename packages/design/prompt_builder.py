import json
import re

from anthropic import Anthropic

from packages.shared_py.config import get_settings
from packages.shared_py.models import FluxPrompt, ImagePrompt, TrendBrief

SYSTEM_PROMPT = """You are an expert AI art director for print-on-demand products.
Given a trend brief, craft an image generation prompt for FLUX Pro 1.1.

Your job is to FAITHFULLY EXECUTE the brief — not to steer its visual register.
The brief's `style_keywords` and `prompt_constraint` carry the rendering
direction (screen print, oil painting, watercolor, papercut, whatever). This
prompt enforces print-readiness and IP/compliance only; it does not impose a
default house style on top of what the brief asked for.

Rules (non-negotiable):
- The prompt MUST include ALL of these exact phrases:
  "print on demand design", "vector-style"
  (FLUX Pro 1.1 incantation phrases — they reliably yield clean, separable
  subjects with this backend. Not a license to override the brief's stated
  rendering register — translate style_keywords into the visual language the
  brief asked for.)
- The prompt MUST also specify a solid background — use EXACTLY one of:
  "white background" OR "black background". Pick whichever contrasts best with
  the design's dominant tones (dark/saturated subjects → "white background";
  light/pastel subjects → "black background"). Do NOT ask for transparent,
  alpha, gradient, or photo backgrounds — downstream tooling removes the
  solid color and produces the final transparent PNG.
- Do NOT include "high resolution", "4K", "8K", or any resolution/quality
  modifier — a dedicated upscaling pass runs after FLUX.
- NEVER include: brand names, registered trademarks (e.g. Stratocaster, Coca-Cola, Nike), copyrighted characters (e.g. Disney/Marvel characters), or named living celebrities (politicians, musicians, actors currently alive)
- People ARE allowed: name historical figures (e.g. Abraham Lincoln, Einstein, Washington), depict generic/anonymous people of any era, and use public-domain characters. Generate the likeness directly when the subject is a historical figure
- Avoid attribution to specific living artists for style — use descriptive art-movement language instead (e.g. "art-deco style" not "Mucha-style")
- NEVER produce wallpaper patterns, repeating motifs, all-over florals, abstract color fields,
  gradient washes, or seamless/tileable backgrounds. The downstream background remover cannot
  process these and apparel printing needs a clear focal subject.
- Every design must have a recognizable focal subject — a figure, object, icon, or piece of
  typography. When the brief sounds abstract or decorative, translate that aesthetic into a
  single iconic motif rendered as a clear centered subject, not as a wallpaper pattern.
- Stay tight to the brief. Do NOT invent setting, scenery, props, environments, atmosphere,
  or any visual element not explicitly named in `niche` / `style_keywords` / `top_tags`. If
  the brief names a subject (e.g. "adventurer"), render that subject — not the subject inside
  a scene. The brief's nouns are the subject; the brief's adjectives are the style. Treat
  every word in style_keywords as a STYLE qualifier, not a scene element. Examples:
    • Brief tags ["adventurer", "dungeon"] → render: a single adventurer figure with
      dungeon-flavored details on the costume (dark armor, torch held by the figure).
      NOT: an adventurer walking into a stone archway with ancient symbols in a moody scene.
    • Brief niche "dark fantasy" + style_keywords ["bold outlines", "muted tones"] →
      "dark fantasy" describes the SUBJECT's vibe; "bold outlines" / "muted tones" describe
      the RENDERING. Neither is permission to add cathedrals, ruins, candles, fog, etc.
- Subject dominance. The focal subject must fill roughly 60–80% of the frame, centered, with
  no wide establishing shot, no environmental context, and no atmospheric backdrop. The
  background is exactly the solid color (white or black) you chose — empty space, not a scene.
  If the brief seems to demand a scene, you are interpreting it wrong: distill it to a single
  subject and render that subject large and centered.
- Translate style keywords into purely descriptive, FLUX-safe language. The brief's
  `style_keywords` carry the rendering register — render whatever they describe (flat
  screen print, painterly chiaroscuro, watercolor wash, papercut layers, etc.). Do NOT
  default to a flat-color / vector / screen-print look unless the brief named it.
- Focus on composition, mood, color, and texture — not specific named references
- Color palette enforcement. When the brief's `color_palette` field is non-empty,
  the prompt MUST contain a literal clause naming every hex in the list as a
  permitted color, e.g. "Use only these colors: #1a2b3c, #ddeeff, #445566 —
  every color in the image must come from this exact list, no other colors
  permitted." Use the exact hex codes verbatim. Do NOT also force flat fills
  or forbid gradients here — that is a style choice driven by `style_keywords`,
  not by palette enforcement. The palette restricts WHICH colors appear; HOW
  they're rendered (flat / blended / painted) is decided by the brief's style.
  If color_palette is empty or null, pick colors freely from the style_keywords
  mood — do NOT invent hex codes the operator didn't specify.
- Operator prompt constraint. When `prompt_constraint` is a non-null, non-empty
  string, treat it as the operator's overriding stylistic instinct for this
  brief. Fold its meaning into the FLUX prompt — adjust style descriptors and
  subject phrasing so the constraint is satisfied. Do NOT silently drop it.
  The constraint is guidance, not a literal phrase to splice in.

Respond ONLY with valid JSON matching this schema exactly:
{
  "prompt": str,           // the full FLUX prompt string
  "negative_prompt": str,  // things to avoid (optional, can be null)
  "style_descriptors": [str]  // 3-7 short aesthetic labels extracted from the brief
}"""

# Appended to SYSTEM_PROMPT only for subject-centric briefs (occupation/identity/hobby).
# Two cache keys (with and without these rules) is intentional — the cost of one extra
# cache entry is negligible compared to the failure mode of unprintable wallpaper output.
SUBJECT_CENTRIC_RULES = """
This brief is subject-centric (occupation/identity/hobby). The prompt MUST include all of these exact phrases: 'centered illustration', 'single subject', 'isolated on plain background', 'clear focal point'.
NEVER produce wallpaper patterns, repeating motifs, all-over florals, or abstract washes for subject-centric briefs. A generic background with no clear figure or object is a prompt failure."""

# Niches that demand a centered, isolated subject rather than wallpaper / abstract output.
# Matched whole-word against `niche` and `top_tags`.
SUBJECT_CENTRIC_KEYWORDS: tuple[str, ...] = (
    # Occupations
    "nurse",
    "teacher",
    "doctor",
    "engineer",
    "firefighter",
    "lawyer",
    "pilot",
    "chef",
    "mechanic",
    "electrician",
    "paramedic",
    "welder",
    "barber",
    "librarian",
    "pharmacist",
    "accountant",
    "realtor",
    "farmer",
    "trucker",
    "coach",
    # Identity / relationship
    "mom",
    "dad",
    "mama",
    "papa",
    "grandma",
    "grandpa",
    "grandmother",
    "grandfather",
    "auntie",
    "uncle",
    "wife",
    "husband",
    "bride",
    "groom",
    "dog mom",
    "cat dad",
    "cat mom",
    "dog dad",
    "plant parent",
    "bonus mom",
    "step dad",
    # Hobbies
    "fishing",
    "hunting",
    "camping",
    "hiking",
    "knitting",
    "crochet",
    "quilting",
    "gardening",
    "yoga",
    "running",
    "cycling",
    "golf",
    "tennis",
    "pickleball",
    "bowling",
    "chess",
    "gaming",
    "birding",
    "astronomy",
    "baking",
    # Life stage
    "retiree",
    "retired",
    "graduate",
    "graduation",
    "student",
    "senior",
    "freshman",
    "newlywed",
    "birthday",
)

REQUIRED_SUBJECT_TERMS: tuple[str, ...] = (
    "centered illustration",
    "single subject",
    "isolated on plain background",
    "clear focal point",
)

# Phrasing that indicates abstract / wallpaper-style output. Forbidden in the FLUX
# prompt and style_descriptors for every brief — even fal.ai's matting models
# can't cleanly cut a tileable background, and POD apparel needs a clear focal
# subject anyway. Allowed in negative_prompt (that's its job).
FORBIDDEN_ABSTRACT_TERMS: tuple[str, ...] = (
    "wallpaper",
    "all-over",
    "all over pattern",
    "repeating pattern",
    "repeating motif",
    "seamless pattern",
    "tileable",
    "color field",
    "color-field",
    "gradient wash",
    "abstract wash",
)

_SUBJECT_CENTRIC_PATTERN = re.compile(
    r"\b(?:" + "|".join(re.escape(kw) for kw in SUBJECT_CENTRIC_KEYWORDS) + r")\b",
    re.IGNORECASE,
)


def is_subject_centric_brief(brief: TrendBrief) -> bool:
    parts: list[str] = [brief.niche]
    if brief.top_tags:
        parts.extend(brief.top_tags)
    haystack = " ".join(parts)
    return bool(_SUBJECT_CENTRIC_PATTERN.search(haystack))


def _require_subject_terms(flux: FluxPrompt) -> None:
    haystack = (flux.prompt + " " + " ".join(flux.style_descriptors)).lower()
    missing = [t for t in REQUIRED_SUBJECT_TERMS if t not in haystack]
    if missing:
        raise ValueError(
            f"FLUX prompt missing required subject-centered phrasing for subject-centric brief: {missing}"
        )


def _reject_abstract_phrasing(flux: FluxPrompt) -> None:
    # Only check the positive prompt + style_descriptors. negative_prompt is allowed
    # (and encouraged) to contain these terms — that is its purpose.
    haystack = (flux.prompt + " " + " ".join(flux.style_descriptors)).lower()
    hits = [t for t in FORBIDDEN_ABSTRACT_TERMS if t in haystack]
    if hits:
        raise ValueError(f"FLUX prompt contains forbidden abstract/wallpaper phrasing: {hits}")


def _palette_clause(palette: list[str] | None) -> str | None:
    """Build a 'use only these colors' clause from a brief's color_palette.

    Returns None when the palette is empty/None or when no entries are valid
    6-char hexes. Enforces WHICH colors appear; does NOT dictate HOW they're
    rendered. Flat fills vs. blended vs. painted is a style choice that lives
    in `style_keywords` / `prompt_constraint`, not in the palette enforcement.
    """
    if not palette:
        return None
    cleaned = [c.strip().lstrip("#") for c in palette]
    hexes = [h for h in cleaned if re.fullmatch(r"[0-9a-fA-F]{6}", h)]
    if not hexes:
        return None
    formatted = " ".join(h.upper() for h in hexes)
    return (
        f" Use only these colors: {formatted}. "
        "Every color in the image must come from this exact list — "
        "no other colors permitted."
    )


# Sentinel phrases that mark a palette clause we (or a prior regen pass)
# already inlined. Detecting them prevents duplicate clauses when the operator
# edits and saves a previously-built prompt — the saved text already contains
# the old palette clause, and a fresh palette change (different hexes) would
# otherwise cause a second clause to be appended.
PALETTE_CLAUSE_MARKERS: tuple[str, ...] = (
    "use only these colors:",
    "use only these ink colors:",  # legacy form, pre-style-neutral refactor
)


def _palette_already_in_prompt(custom: str, palette: list[str] | None) -> bool:
    """True when the prompt already contains a palette clause we shouldn't
    duplicate. Triggers on either:
      • the literal "Use only these colors:" sentinel from a prior auto-append
        or a previous regen pass (catches the case where the operator changed
        the palette but the old clause still lives inside the edited text), or
      • any of the current palette's hex codes appearing inline (operator
        wrote their own palette list).

    The first check fires even when palette hexes have changed — the operator's
    edited text is treated as final form and an additional clause would just
    pollute the prompt.
    """
    lowered = custom.lower()
    if any(marker in lowered for marker in PALETTE_CLAUSE_MARKERS):
        return True
    if palette:
        for c in palette:
            h = c.strip().lstrip("#").lower()
            if len(h) == 6 and h in lowered:
                return True
    return False


# Sentinel for the operator-instruction suffix we inline from prompt_constraint.
# Without dedup the constraint clause stacks every time the operator regens
# from an already-built prompt.
CONSTRAINT_CLAUSE_MARKER = "operator instruction (must follow):"


def _constraint_already_in_prompt(custom: str) -> bool:
    return CONSTRAINT_CLAUSE_MARKER in custom.lower()


# Border-safe framing clause appended to every dashboard-injected prompt
# (FLUX + gpt-image-2 paths) unless the operator already addressed framing
# inline. gpt-image-2 defaults to filling the canvas edge-to-edge — the
# subject and any ground tile usually touch all four borders unless told
# otherwise. For print-on-demand, anything touching the edge produces a
# hard rectangular cutoff after background removal, which photographs as
# a square sticker instead of a free-standing graphic.
FRAMING_CLAUSE = (
    " Leave a generous empty border around the entire image: the subject, "
    "the ground, and every other element must stay well inside the frame and "
    "never touch the top, bottom, left, or right edges. The area between the "
    "subject and the image edges is plain empty background extending all the "
    "way to the corners."
)

# Phrases that indicate the operator already wrote a framing/border constraint
# inline. Case-insensitive substring match — if any of these appears we skip
# the auto-append so we don't double-list.
FRAMING_HINTS = (
    "must not touch",
    "empty border",
    "empty margin",
    "margin around",
    "padding around",
    "edges of the image",
    "image border",
    "image edge",
    "border-safe",
)


def _framing_already_in_prompt(custom: str) -> bool:
    lowered = custom.lower()
    return any(hint in lowered for hint in FRAMING_HINTS)


def _constraint_clause(constraint: str | None) -> str | None:
    """Build a 'follow this operator instruction' clause from a brief's
    prompt_constraint. Returns None when the constraint is empty/whitespace.

    Appended verbatim to custom prompts so the operator's instinct survives
    even when they bypass Claude. The leading newline keeps it visually
    distinct from the prompt body in fal.ai logs and helps gpt-image-2 read
    it as a separate directive rather than merging it into the subject
    description.
    """
    if not constraint:
        return None
    text = constraint.strip()
    if not text:
        return None
    return f"\n\nOperator instruction (must follow): {text}"


def build_flux_prompt(brief: TrendBrief) -> FluxPrompt:
    # Dashboard-injected override path: caller pre-baked the prompt, skip
    # Claude entirely. The FluxPrompt validator still enforces
    # FLUX_REQUIRED_TERMS — prompts missing the required phrases will raise
    # and the row will land in 'error' with a useful message.
    #
    # Palette is injected here too: the operator's custom prompt may have been
    # written before they picked colors, or the colors may have been edited on
    # the review card without rewriting the prompt. Append the palette clause
    # unless the operator already named these hexes inline.
    custom = (brief.custom_flux_prompt or "").strip()
    if custom:
        if not _palette_already_in_prompt(custom, brief.color_palette):
            clause = _palette_clause(brief.color_palette)
            if clause:
                custom = custom + clause
        if not _framing_already_in_prompt(custom):
            custom = custom + FRAMING_CLAUSE
        if not _constraint_already_in_prompt(custom):
            constraint_clause = _constraint_clause(brief.prompt_constraint)
            if constraint_clause:
                custom = custom + constraint_clause
        return FluxPrompt(prompt=custom, negative_prompt=None, style_descriptors=[])

    settings = get_settings()
    client = Anthropic(api_key=settings.anthropic_api_key)

    subject_centric = is_subject_centric_brief(brief)

    system_text = SYSTEM_PROMPT
    if subject_centric:
        system_text += SUBJECT_CENTRIC_RULES

    # `prompt_constraint` flows into the user JSON as a high-priority hint.
    # The system prompt explicitly names this field so Claude treats it as
    # a non-optional directive when constructing the FLUX prompt.
    user_content = json.dumps(
        {
            "niche": brief.niche,
            "style_keywords": brief.style_keywords,
            "color_palette": brief.color_palette,
            "top_tags": brief.top_tags,
            "prompt_constraint": brief.prompt_constraint,
        },
        indent=2,
    )

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=1024,
        system=[
            {
                "type": "text",
                "text": system_text,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[{"role": "user", "content": user_content}],
    )

    # Best-effort consumption log for the dashboard.
    from packages.shared_py.llm_usage import (  # noqa: PLC0415
        estimate_anthropic_cost_usd,
        record_usage,
    )

    usage = getattr(response, "usage", None)
    if usage is not None:
        record_usage(
            agent="design",
            provider="anthropic",
            operation="build_flux_prompt",
            cost_usd=estimate_anthropic_cost_usd(
                model="claude-sonnet-4-20250514",
                input_tokens=getattr(usage, "input_tokens", 0) or 0,
                output_tokens=getattr(usage, "output_tokens", 0) or 0,
                cache_read_input_tokens=getattr(usage, "cache_read_input_tokens", 0) or 0,
                cache_creation_input_tokens=getattr(usage, "cache_creation_input_tokens", 0) or 0,
            ),
            input_tokens=getattr(usage, "input_tokens", None),
            output_tokens=getattr(usage, "output_tokens", None),
            metadata={
                "model": "claude-sonnet-4-20250514",
                "niche": brief.niche,
                "subject_centric": subject_centric,
            },
        )

    first_block = response.content[0]
    if first_block.type != "text":
        raise ValueError(f"Claude returned unexpected block type: {first_block.type}")
    raw_text = first_block.text.strip()
    if raw_text.startswith("```"):
        raw_text = raw_text.split("```", 2)[1]
        if raw_text.startswith("json"):
            raw_text = raw_text[4:]
        raw_text = raw_text.strip()
    try:
        data = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Claude returned invalid JSON: {raw_text!r}") from exc

    flux = FluxPrompt.model_validate(data)

    _reject_abstract_phrasing(flux)
    if subject_centric:
        _require_subject_terms(flux)

    return flux


# ---------------------------------------------------------------------------
# gpt-image-2 prompt building
# ---------------------------------------------------------------------------

# gpt-image-2 follows literal English natural-language prompts. The system
# prompt is organized by PRIORITY — when rules conflict, the higher-priority
# rule wins and the lower-priority rule drops out.
#
# Design is content-neutral by design: it enforces print-readiness, IP, and
# the operator's constraint, but it does NOT impose a default visual register.
# The brief's `style_keywords` and `prompt_constraint` carry the rendering
# direction (screen print, oil painting, watercolor, papercut, whatever). If
# the brief is silent, Claude picks a register that fits the subject — but
# never falls back to a house screen-print formula.
GPT_IMAGE_SYSTEM_PROMPT = """You are an expert AI art director for print-on-demand apparel.
Given a trend brief, craft a natural-English image generation prompt for OpenAI's gpt-image-2.

Your job is to FAITHFULLY EXECUTE the brief — not to steer its visual register.
The brief's `style_keywords` and `prompt_constraint` decide the rendering
register (screen print, oil painting, watercolor, papercut, ink wash, pixel
art, whatever). This prompt enforces print-readiness, IP/compliance, and the
operator's constraint — it does NOT impose a default house style on top.

RULES ARE ORDERED BY PRIORITY. When two rules would conflict, the higher-
priority rule wins and the lower-priority one is dropped. Never stack
contradictory directives in the same prompt (e.g. "dramatic shadows and
highlights" + "flat solid colors no shading" — pick whichever the brief asked
for, drop the other).

══════════════════════════════════════════════════════════════════════════
PRIORITY 1 — OPERATOR PROMPT CONSTRAINT (highest authority)
══════════════════════════════════════════════════════════════════════════
When `prompt_constraint` is a non-null, non-empty string, it is the operator's
authoritative instinct for THIS brief. Read it carefully and let it DRIVE the
prompt — it may override anything below except IP/compliance and print-
readiness (those are physical/legal constraints, not style preferences).

The constraint is GUIDANCE, not a literal phrase to splice in. Use it to STEER.

When the constraint asks for SPECIFICITY (e.g. "a specific well-known classical
painting", "a particular movie poster style"), BE specific in the output. Don't
write "a classical portrait" — write "Vermeer's Girl with a Pearl Earring" or
"Grant Wood's American Gothic" or "Whistler's Mother". Pick a real, recognizable
composition. ("Dealer's choice" = you pick a real one.)

When the constraint asks for a stylistic register, the constraint wins. DROP
any contradictory style language from style_keywords. Do not write "dramatic
shadows" AND "no shading" in the same prompt.

WORKED EXAMPLE — constraint asks for painting recreation:
  `prompt_constraint`: "Recreate a specific well-known classical painting
  composition but replace all human subjects with a single animal species.
  Maintain the original composition, lighting, and mood."
  `niche`: "cat"
  → Correct output:
  "A single centered illustration recreating the exact composition of Vermeer's
  'Girl with a Pearl Earring', but with a tabby cat in place of the girl: three-
  quarter pose, head turned toward the viewer, soft directional light from the
  upper left, deep shadow falling on the right side of the face, a single pearl
  earring visible in one ear. Render with Vermeer's restrained warm palette and
  painterly chiaroscuro — preserve the original shadows and highlights. The cat
  must have a naturally feline face with no human expressiveness, just a calm
  steady stare. Leave a generous empty border around the image — the subject
  must not touch any edge."

WORKED EXAMPLE — constraint is a directional tweak (not a style override):
  `prompt_constraint`: "make the character look grumpy but still cute"
  `niche`: "frog knight"
  `style_keywords`: ["screen print", "bold outlines", "flat colors"]
  → Render a flat-color screen-print frog knight (style from style_keywords),
    with a grumpy-but-cute facial expression (constraint applied to subject).
    The constraint adjusts the subject; it doesn't override the style.

══════════════════════════════════════════════════════════════════════════
PRIORITY 2 — IP / COMPLIANCE (always)
══════════════════════════════════════════════════════════════════════════
- Never include brand names, registered trademarks, copyrighted characters, or
  named living celebrities. Historical figures (Lincoln, Einstein, Washington)
  and generic/anonymous people are fine.
- Use art-movement descriptors instead of named living-artist style copies
  ("art-deco style", not "Mucha-style"). EXCEPTION: when the constraint asks
  to reference a SPECIFIC public-domain painting, naming the painting and its
  long-dead artist (Vermeer, da Vinci, Wood, Whistler) is fine — that's a
  composition reference, not brand mimicry.

══════════════════════════════════════════════════════════════════════════
PRIORITY 3 — PRINT READINESS (always — physical constraint)
══════════════════════════════════════════════════════════════════════════
- ONE centered focal subject. Subject fills roughly 60–80% of the frame.
- Generous empty border on all four sides — the subject and any ground tile
  must NEVER touch the top, bottom, left, or right edges. The space between
  the subject and the image edges is plain empty background extending all the
  way to the corners. Include a literal framing clause in the prompt
  describing this.
- No wallpaper patterns, repeating motifs, all-over florals, abstract color
  fields, gradient washes, seamless/tileable backgrounds, or wide
  establishing shots.
- No sky, no horizon, no scenery, no buildings, no weather, no atmospheric
  backdrop — the focal subject is what we're printing.

══════════════════════════════════════════════════════════════════════════
PRIORITY 4 — STYLE COMES FROM THE BRIEF, NEVER FROM THIS PROMPT
══════════════════════════════════════════════════════════════════════════
This prompt has NO default rendering style. Do not open with "A single centered
screen print of…" or any other house formula. Do not default to flat colors,
bold outlines, vector look, character-print-study framing, or "no gradients,
no shading" riders. Those are style choices that belong to the brief, not to
this agent.

Read `style_keywords` and `prompt_constraint` and faithfully render whatever
register they describe:
  • style_keywords ["screen print", "flat color", "bold outlines"] →
    Open with "A single centered screen print of <SUBJECT>." Render with flat
    color fills, bold outlines, strong silhouette, no gradients, no shading.
  • style_keywords ["oil painting", "chiaroscuro"] →
    Render painterly with shadows and highlights, visible brushwork; DO NOT
    flatten to vector.
  • style_keywords ["watercolor", "loose"] →
    Soft washes, bleeding edges, visible paper texture; not flat fills.
  • style_keywords ["papercut", "layered"] →
    Crisp layered paper shapes, hard edges, subtle shadow between layers.
  • style_keywords ["pixel art", "16-bit"] →
    Crisp pixel grid, limited palette, no anti-aliasing.

When the brief is silent on rendering register (style_keywords empty/generic
and no prompt_constraint), pick a clean illustrative register that suits the
subject — but do NOT force flat-color / screen-print / vector unless something
in the brief actually pointed there.

For animal-as-character subjects regardless of style: state the head is
ANIMAL-shaped with no human expressiveness — "a very <animal>-like head, no
human expressiveness, just a calm steady stare". This is a subject-clarity
rule (animals shouldn't morph into anthropomorphic faces), not a style rule.

══════════════════════════════════════════════════════════════════════════
COLOR PALETTE
══════════════════════════════════════════════════════════════════════════
When `color_palette` is non-empty, the prompt MUST include a clause like:
"Use only these colors: <HEX1> <HEX2> <HEX3>..." (exact hex codes from the
brief, space-separated, uppercase, with or without leading #).

After the color list, add: "Every color in the image must come from this
exact list — no other colors permitted." Do NOT also force flat fills or
forbid gradients here — that is a style choice that lives in `style_keywords`,
not in palette enforcement. The palette restricts WHICH colors appear; HOW
they're rendered (flat / blended / painted) is a style decision driven by
the brief.

When `color_palette` is empty/null, pick 4–5 colors that fit the brief's mood.
Never invent hex codes the operator didn't specify.

══════════════════════════════════════════════════════════════════════════
SUBJECT DERIVATION
══════════════════════════════════════════════════════════════════════════
Distill the brief's nouns into the subject; adjectives are the style. Don't
invent setting/scenery the brief didn't name. Example:
  • Brief tags ["adventurer", "dungeon"] → subject is "adventurer", "dungeon"
    colors the costume (dark armor, torch in hand). NOT a wide dungeon scene.

Respond ONLY with valid JSON matching this schema exactly:
{
  "prompt": str,            // the full natural-English prompt
  "style_descriptors": [str]  // 3-7 short aesthetic labels extracted from the brief
}"""


def build_gpt_image_prompt(brief: TrendBrief) -> ImagePrompt:
    # Dashboard-injected override path: use the operator's literal prompt.
    # No FLUX-required-phrase enforcement — gpt-image-2 takes plain English.
    # Palette is auto-appended when set but not already inline (same flow as
    # the FLUX builder — keep them parallel).
    custom = (brief.custom_flux_prompt or "").strip()
    if custom:
        if not _palette_already_in_prompt(custom, brief.color_palette):
            clause = _palette_clause(brief.color_palette)
            if clause:
                custom = custom + clause
        if not _framing_already_in_prompt(custom):
            custom = custom + FRAMING_CLAUSE
        if not _constraint_already_in_prompt(custom):
            constraint_clause = _constraint_clause(brief.prompt_constraint)
            if constraint_clause:
                custom = custom + constraint_clause
        return ImagePrompt(prompt=custom, style_descriptors=[])

    settings = get_settings()
    client = Anthropic(api_key=settings.anthropic_api_key)

    user_content = json.dumps(
        {
            "niche": brief.niche,
            "style_keywords": brief.style_keywords,
            "color_palette": brief.color_palette,
            "top_tags": brief.top_tags,
            "prompt_constraint": brief.prompt_constraint,
        },
        indent=2,
    )

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=1024,
        system=[
            {
                "type": "text",
                "text": GPT_IMAGE_SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[{"role": "user", "content": user_content}],
    )

    from packages.shared_py.llm_usage import (  # noqa: PLC0415
        estimate_anthropic_cost_usd,
        record_usage,
    )

    usage = getattr(response, "usage", None)
    if usage is not None:
        record_usage(
            agent="design",
            provider="anthropic",
            operation="build_gpt_image_prompt",
            cost_usd=estimate_anthropic_cost_usd(
                model="claude-sonnet-4-20250514",
                input_tokens=getattr(usage, "input_tokens", 0) or 0,
                output_tokens=getattr(usage, "output_tokens", 0) or 0,
                cache_read_input_tokens=getattr(usage, "cache_read_input_tokens", 0) or 0,
                cache_creation_input_tokens=getattr(usage, "cache_creation_input_tokens", 0) or 0,
            ),
            input_tokens=getattr(usage, "input_tokens", None),
            output_tokens=getattr(usage, "output_tokens", None),
            metadata={
                "model": "claude-sonnet-4-20250514",
                "niche": brief.niche,
                "image_model": "fal_gpt_image_2",
            },
        )

    first_block = response.content[0]
    if first_block.type != "text":
        raise ValueError(f"Claude returned unexpected block type: {first_block.type}")
    raw_text = first_block.text.strip()
    if raw_text.startswith("```"):
        raw_text = raw_text.split("```", 2)[1]
        if raw_text.startswith("json"):
            raw_text = raw_text[4:]
        raw_text = raw_text.strip()
    try:
        data = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Claude returned invalid JSON: {raw_text!r}") from exc

    return ImagePrompt.model_validate(data)


def build_image_prompt(brief: TrendBrief) -> FluxPrompt | ImagePrompt:
    """Backend dispatcher. FLUX briefs go through the validated FLUX builder;
    everything else through the natural-English builder for gpt-image-2."""
    if brief.image_model == "fal_flux_pro":
        return build_flux_prompt(brief)
    return build_gpt_image_prompt(brief)

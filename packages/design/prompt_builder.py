import json
import re
from typing import Any

from anthropic import AsyncAnthropic

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
- Do NOT include "high resolution", "4K", "8K", or any resolution/quality
  modifier — a dedicated upscaling pass runs after FLUX.
- Print-readiness (solid background, framing, singular centered subject) is
  enforced downstream by Design's preprocessing step. You don't need to bake
  in incantation phrases for those — focus on getting the subject and style
  right. The downstream pipeline will append the print constraints.
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
  background is a plain solid color — default to black unless the brief explicitly asks for
  a different solid color. Empty space, not a scene. If the brief seems to demand a scene,
  you are interpreting it wrong: distill it to a single subject and render that subject
  large and centered.
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


# Print-readiness clause: force a plain solid BLACK background by default.
# Anything other than a flat solid color photographs as a square sticker
# after rembg/bria cuts the silhouette — the model often invents textured
# or gradient backgrounds when the prompt doesn't explicitly forbid them.
# Black is the default per operator preference (2026-05-14): most apparel
# in our catalog is dark, and a black plate gives the background remover
# the cleanest silhouette to cut against most subjects. The operator can
# override by writing "white background" / "plain blue background" / etc.
# inline — _background_already_in_prompt will then skip this auto-append.
BACKGROUND_CLAUSE = (
    " The background must be plain solid black — no scene, no environment, "
    "no texture, no gradient. Use pure black as the flat backdrop unless "
    "the subject's silhouette requires a different solid color for contrast."
)

# Operator-language signals that they've already addressed the background.
# Case-insensitive substring match — any hit skips the auto-append to avoid
# stacking conflicting background directives on regen.
BACKGROUND_HINTS = (
    "white background",
    "black background",
    "plain background",
    "solid background",
    "blank background",
    "no background",
    "transparent background",
    # Self-clause marker so a regen of an already-stamped prompt skips the
    # second append. Distinctive enough not to collide with the FRAMING_CLAUSE
    # wording (which mentions "plain empty background" but never "must be").
    "background must be plain solid",
)


def _background_already_in_prompt(custom: str) -> bool:
    lowered = custom.lower()
    return any(hint in lowered for hint in BACKGROUND_HINTS)


# Print-readiness clause: one subject, centered. Image models default to busy
# multi-subject compositions when the prompt is silent on count, which makes
# the resulting print read as cluttered after background removal.
SUBJECT_CLAUSE = (
    " Render exactly ONE singular subject centered in the frame — no second "
    "character, no duplicates, no companion objects competing for focus. "
    "Supporting motifs may appear as small accents but the composition must "
    "read as a single subject."
)

# Operator-language signals they've already addressed subject count/position.
# Includes opt-outs ("two subjects", "multiple") so the operator can override
# the singular-subject default without us re-stacking it.
SUBJECT_HINTS = (
    "single subject",
    "singular subject",
    "one subject",
    "two subjects",
    "multiple subjects",
    "centered",
    "in the center",
    "central composition",
)


def _subject_already_in_prompt(custom: str) -> bool:
    lowered = custom.lower()
    return any(hint in lowered for hint in SUBJECT_HINTS)


# Print-readiness clause: enforce a strong silhouette that survives at full-chest
# print scale. The image models default to compositions optimized for screen
# viewing (fine details, low-contrast accents) which lose legibility on apparel.
# Pattern lifted from the winning approved designs (2026-05-14 audit) — every
# strong winner either had this language inline or implicitly satisfied it via
# thick outlines + bold shapes. Making it an explicit auto-append surfaces the
# constraint to the model when the operator didn't think to.
# Full-chest print area on Gildan 64000: up to 14"×16". Targeting 10–12" width
# as the legibility anchor — designs must hold up at that scale, not pocket scale.
READABILITY_CLAUSE = (
    " Strong silhouette that reads at full-chest print scale — shapes large and bold "
    "enough and contrast high enough that the design is legible at ten to twelve inches across."
)

# Operator-language signals that they've already addressed print-size
# readability. Skip the auto-append when any of these substrings appears.
# "strong silhouette" alone is a common style cue in screen-print briefs;
# trusting the operator's wording is safer than double-stamping.
READABILITY_HINTS = (
    "reads at full-chest",
    "ten to twelve inches",
    "reads at chest",
    "legible at",
    "strong silhouette",
    "chest-pocket scale",
)


def _readability_already_in_prompt(custom: str) -> bool:
    lowered = custom.lower()
    return any(hint in lowered for hint in READABILITY_HINTS)


# ---------------------------------------------------------------------------
# Shared helpers (used by both build_flux_prompt and build_gpt_image_prompt)
# ---------------------------------------------------------------------------

_CLAUDE_MODEL = "claude-sonnet-4-20250514"


def _preprocess_custom_prompt(
    custom: str,
    palette: list[str] | None,
) -> str:
    """Append print-readiness clauses to a dashboard-injected custom prompt.

    Design's job at this stage is *not* to re-synthesize what the operator
    wrote — that already happened in Builder (or in the operator's edit on
    the Design review card). Here we only enforce print mechanics:

      1. Palette — restrict to the brief's color list when present (and
         only when the prompt doesn't already reference those colors).
      2. Framing — leave a border so the silhouette doesn't photograph as
         a square sticker after background removal.
      3. Background — plain solid black or white. Anything else creates
         halos and clutter after the cutout.
      4. Subject count — one centered subject. Image models default to
         busy multi-subject compositions when the prompt is silent.
      5. Readability — strong silhouette that reads at six-inch print
         scale. Without this the model tends to optimize for screen-resolution
         detail that disappears on apparel.

    Every clause is idempotent (skipped when the operator already addressed
    that dimension inline) so repeated regens don't stack. The prior
    "Operator instruction (must follow):" tail-append from prompt_constraint
    has been removed entirely — it caused the trailing override to fight
    the operator's edits on regen-with-edit. Shared by both FLUX and
    gpt-image-2 builders; keep parity so the two backends behave identically.
    """
    if not _palette_already_in_prompt(custom, palette):
        clause = _palette_clause(palette)
        if clause:
            custom = custom + clause
    if not _framing_already_in_prompt(custom):
        custom = custom + FRAMING_CLAUSE
    if not _background_already_in_prompt(custom):
        custom = custom + BACKGROUND_CLAUSE
    if not _subject_already_in_prompt(custom):
        custom = custom + SUBJECT_CLAUSE
    if not _readability_already_in_prompt(custom):
        custom = custom + READABILITY_CLAUSE
    return custom


def _build_user_content(brief: TrendBrief) -> str:
    """Canonical user-content JSON sent to Claude — same five fields for
    both backends. `prompt_constraint` is treated as a high-priority hint
    by both system prompts when it's non-null.
    """
    return json.dumps(
        {
            "niche": brief.niche,
            "style_keywords": brief.style_keywords,
            "color_palette": brief.color_palette,
            "top_tags": brief.top_tags,
            "prompt_constraint": brief.prompt_constraint,
        },
        indent=2,
    )


def _parse_json_response(text: str) -> dict[str, Any]:
    """Strip optional markdown fences and decode JSON. Both builders use
    the same fence/decode handling; the only difference is the schema
    that downstream model_validate runs against."""
    raw = text.strip()
    if raw.startswith("```"):
        raw = raw.split("```", 2)[1]
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Claude returned invalid JSON: {raw!r}") from exc


async def _call_claude(
    *,
    system_text: str,
    user_content: str,
    operation: str,
    metadata: dict[str, Any],
) -> tuple[str, Any]:
    """Async Anthropic call with ephemeral cache + best-effort usage
    tracking. Returns ``(raw_text, response)`` — the response is exposed
    so tests can still inspect ``client.messages.create.call_args``.

    Converged on ``AsyncAnthropic`` (matches ``scout/dedup.py``). The
    previous sync ``Anthropic`` client was only safe because callers
    wrapped this in ``asyncio.to_thread`` — AUDIT_4 H8 flagged that
    fragility; this helper resolves it for both backends.
    """
    settings = get_settings()
    client = AsyncAnthropic(api_key=settings.anthropic_api_key)
    response = await client.messages.create(
        model=_CLAUDE_MODEL,
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

    # Best-effort consumption log for the dashboard. Imported inline to
    # avoid pulling llm_usage into the import graph when the module is
    # used purely for its constants (e.g. compliance tests).
    from packages.shared_py.llm_usage import (  # noqa: PLC0415
        estimate_anthropic_cost_usd,
        record_usage,
    )

    usage = getattr(response, "usage", None)
    if usage is not None:
        record_usage(
            agent="design",
            provider="anthropic",
            operation=operation,
            cost_usd=estimate_anthropic_cost_usd(
                model=_CLAUDE_MODEL,
                input_tokens=getattr(usage, "input_tokens", 0) or 0,
                output_tokens=getattr(usage, "output_tokens", 0) or 0,
                cache_read_input_tokens=getattr(usage, "cache_read_input_tokens", 0) or 0,
                cache_creation_input_tokens=getattr(usage, "cache_creation_input_tokens", 0) or 0,
            ),
            input_tokens=getattr(usage, "input_tokens", None),
            output_tokens=getattr(usage, "output_tokens", None),
            metadata=metadata,
        )

    first_block = response.content[0]
    if first_block.type != "text":
        raise ValueError(f"Claude returned unexpected block type: {first_block.type}")
    return first_block.text, response


# ---------------------------------------------------------------------------
# Public builders
# ---------------------------------------------------------------------------


async def build_flux_prompt(brief: TrendBrief) -> FluxPrompt:
    # Builder/operator-authored description path: use verbatim, skip Claude
    # entirely. The historical FLUX_REQUIRED_TERMS validator was removed in
    # the 2026-05-14 cleanup; FLUX Pro 1.1 produces good results without the
    # incantation phrases per current operator observation.
    custom = (brief.image_description or "").strip()
    if custom:
        custom = _preprocess_custom_prompt(custom, brief.color_palette)
        return FluxPrompt(prompt=custom, negative_prompt=None, style_descriptors=[])

    subject_centric = is_subject_centric_brief(brief)
    system_text = SYSTEM_PROMPT + (SUBJECT_CENTRIC_RULES if subject_centric else "")

    raw_text, _response = await _call_claude(
        system_text=system_text,
        user_content=_build_user_content(brief),
        operation="build_flux_prompt",
        metadata={
            "model": _CLAUDE_MODEL,
            "niche": brief.niche,
            "subject_centric": subject_centric,
        },
    )

    flux = FluxPrompt.model_validate(_parse_json_response(raw_text))
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
- Background defaults to plain solid BLACK. Use a different flat color only
  when the brief or prompt_constraint explicitly asks for one (e.g.
  "white background", "red background"). Never gradients, never scenes.
  Most of our catalog is dark apparel and black plates cut cleanest through
  the downstream background remover.
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

For animal-as-character subjects regardless of style: render the head as
FULLY <animal>-shaped with no humanized features. Specify every dimension
the model would otherwise default-anthropomorphize:
  • Eyes: bulging / wide / small / black-dot — name a specific shape.
  • Mouth: broad / closed / small / curved — name a shape; never "smiling".
  • Expression: "no human expressiveness, just an alert forward stare" or
    "just a calm steady gaze" or "just a serene downward stare". Pattern is
    "no human expressiveness, just a <descriptor> <direction> stare/gaze".
  • Posture: name natural <animal> posture / proportions (e.g. "natural frog
    posture", "feline body proportions", "raccoon hand stance").
The animal-as-character should read as an *animal* doing a thing, not a
human-with-animal-head. This is a subject-clarity rule (animals shouldn't
morph into anthropomorphic faces), not a style rule — applies whether the
render is cartoon, realistic, ukiyo-e, screen print, or anything else.

══════════════════════════════════════════════════════════════════════════
PROMPT CRAFT — opener shape and pose specificity
══════════════════════════════════════════════════════════════════════════
Patterns from approved winning designs (2026-05-14 audit). Apply these to
every prompt you generate.

MEDIUM-FIRST OPENER. Open with the medium, then the subject, then a named
action. The medium primes the model's rendering choices for the rest of
the prompt — switching the order makes the medium feel optional.
  • Right: "A hand-pulled screen print of a frog knight in mid-charge…"
  • Wrong: "A frog knight in mid-charge, screen-printed style…"
  • Right: "A Japanese ukiyo-e woodblock print of a frog samurai in…"
  • Right: "A 16-bit pixel art wizard in the Hadouken pose…"
The opener carries the technique. After the opener you're describing what
to render *in* that technique, not adding the technique as a modifier.

POSE / ACTION SPECIFICITY. When the brief names a subject doing something,
render the pose with explicit body-part placement. Don't write "a frog
samurai"; write "a frog samurai in mid-battle stance, katana raised
overhead with both front legs, wearing traditional lamellar armor." Always
name:
  • Stance / posture (crouched / standing / mid-leap / seated).
  • Where the hands / paws / wings / legs are positioned.
  • What they're holding and how it's gripped.
  • Direction of gaze (forward / downward / over-the-shoulder).
The specificity is the difference between "the model interprets" and "the
model executes." Generic poses produce generic results.

ACTIVE NEGATION. When the chosen technique forbids something, say so
out loud. "Flat colors, NO gradients" beats "flat colors". "Crisp pixel
grid, NO anti-aliasing" beats "crisp pixel grid". The winning prompts
actively forbid the failure modes of the chosen technique rather than
hoping the model infers them.

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


async def build_gpt_image_prompt(brief: TrendBrief) -> ImagePrompt:
    # Dashboard-injected override path: use the operator's literal prompt.
    # No FLUX-required-phrase enforcement — gpt-image-2 takes plain English.
    # Palette / framing / constraint clauses are auto-appended via the
    # shared helper so both backends behave identically on injected
    # prompts.
    custom = (brief.image_description or "").strip()
    if custom:
        custom = _preprocess_custom_prompt(custom, brief.color_palette)
        return ImagePrompt(prompt=custom, style_descriptors=[])

    raw_text, _response = await _call_claude(
        system_text=GPT_IMAGE_SYSTEM_PROMPT,
        user_content=_build_user_content(brief),
        operation="build_gpt_image_prompt",
        metadata={
            "model": _CLAUDE_MODEL,
            "niche": brief.niche,
            "image_model": "fal_gpt_image_2",
        },
    )

    return ImagePrompt.model_validate(_parse_json_response(raw_text))


async def build_image_prompt(brief: TrendBrief) -> FluxPrompt | ImagePrompt:
    """Backend dispatcher.

    FLUX briefs go through the validated FLUX builder (ritual-phrase enforced).
    gpt-image-2 and nano-banana-2 both consume natural English and share the
    same builder — both models reject tag-style prompts and "masterpiece /
    best quality" boosters, both render literal English well. The per-model
    differences (resolution semantics, safety tolerance, watermarking) live
    in their respective clients, not in prompt construction.
    """
    if brief.image_model == "fal_flux_pro":
        return await build_flux_prompt(brief)
    return await build_gpt_image_prompt(brief)

import json
import re

from anthropic import Anthropic

from packages.shared_py.config import get_settings
from packages.shared_py.models import FluxPrompt, TrendBrief

SYSTEM_PROMPT = """You are an expert AI art director for print-on-demand products.
Given a trend brief, craft an image generation prompt for FLUX Pro 1.1.

Rules (non-negotiable):
- The prompt MUST include ALL of these exact phrases:
  "print on demand design", "transparent background", "high resolution", "vector-style"
- NEVER include: artist names, brand names, living people, copyrighted characters
- NEVER produce wallpaper patterns, repeating motifs, all-over florals, abstract color fields,
  gradient washes, or seamless/tileable backgrounds. The downstream background remover cannot
  process these and apparel printing needs a clear focal subject.
- Every design must have a recognizable focal subject — a figure, object, icon, or piece of
  typography. When the brief sounds abstract or decorative, translate that aesthetic into a
  single iconic motif rendered as a clear centered subject, not as a wallpaper pattern.
- Translate style keywords and color palette into purely descriptive, FLUX-safe language
- Focus on composition, mood, color, and texture — not specific named references

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

# Appended to SYSTEM_PROMPT only for screen-print briefs. Forces FLUX to output a
# single-ink-color design with no tonal range, because the post-processing pass
# strips all near-white pixels — gradients/halftones would print as ragged dots.
SCREEN_PRINT_RULES = """
This brief is a single-color screen print. The prompt MUST include all of these exact phrases: 'single ink color', 'solid shapes', 'no gradients', 'no halftones', 'no shading', 'bold vector-style screen print'.
NEVER include gradients, halftones, shading, color blends, soft shadows, or photorealistic rendering. The output must be bold solid shapes in one ink color (black is fine) on a clean background — anything tonal will be destroyed by the downstream interior-whitespace strip."""

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

# Exact phrases the FLUX prompt must include when a brief is classified as
# screen_print. Validated post-generation, mirroring REQUIRED_SUBJECT_TERMS.
REQUIRED_SCREEN_PRINT_TERMS: tuple[str, ...] = (
    "single ink color",
    "solid shapes",
    "no gradients",
    "no halftones",
    "no shading",
    "bold vector-style screen print",
)

# Phrasing that's incompatible with single-ink screen printing. Only forbidden
# when print_style == "screen_print"; full-color designs are allowed to use
# gradients and shading. Allowed in negative_prompt for screen_print briefs
# (that's the right place to tell FLUX what to avoid).
SCREEN_PRINT_FORBIDDEN_TERMS: tuple[str, ...] = (
    "gradient",
    "halftone",
    "shading",
    "color blend",
)

# Phrasing that indicates abstract / wallpaper-style output. Forbidden in the FLUX
# prompt and style_descriptors for every brief — rembg cannot cleanly process these
# and POD apparel needs a clear subject. Allowed in negative_prompt (that's its job).
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


def _require_screen_print_terms(flux: FluxPrompt) -> None:
    haystack = (flux.prompt + " " + " ".join(flux.style_descriptors)).lower()
    missing = [t for t in REQUIRED_SCREEN_PRINT_TERMS if t not in haystack]
    if missing:
        raise ValueError(
            f"FLUX prompt missing required screen-print phrasing for screen_print brief: {missing}"
        )


def _reject_abstract_phrasing(flux: FluxPrompt) -> None:
    # Only check the positive prompt + style_descriptors. negative_prompt is allowed
    # (and encouraged) to contain these terms — that is its purpose.
    haystack = (flux.prompt + " " + " ".join(flux.style_descriptors)).lower()
    hits = [t for t in FORBIDDEN_ABSTRACT_TERMS if t in haystack]
    if hits:
        raise ValueError(f"FLUX prompt contains forbidden abstract/wallpaper phrasing: {hits}")


def _reject_screen_print_forbidden(flux: FluxPrompt) -> None:
    # Strip the required negation phrases ('no gradients', 'no halftones',
    # 'no shading') before scanning for forbidden substrings — otherwise
    # legitimate negation phrasing would trip the check (e.g. 'no gradients'
    # contains the substring 'gradient'). Same pattern as the listing
    # compliance validator stripping AI_DISCLOSURE_TEXT before forbidden-term scan.
    haystack = (flux.prompt + " " + " ".join(flux.style_descriptors)).lower()
    for required in REQUIRED_SCREEN_PRINT_TERMS:
        haystack = haystack.replace(required, "")
    hits = [t for t in SCREEN_PRINT_FORBIDDEN_TERMS if t in haystack]
    if hits:
        raise ValueError(
            f"FLUX prompt contains tonal phrasing incompatible with screen_print: {hits}"
        )


def build_flux_prompt(brief: TrendBrief) -> FluxPrompt:
    settings = get_settings()
    client = Anthropic(api_key=settings.anthropic_api_key)

    subject_centric = is_subject_centric_brief(brief)
    screen_print = brief.print_style == "screen_print"

    system_text = SYSTEM_PROMPT
    if subject_centric:
        system_text += SUBJECT_CENTRIC_RULES
    if screen_print:
        system_text += SCREEN_PRINT_RULES

    user_content = json.dumps(
        {
            "niche": brief.niche,
            "style_keywords": brief.style_keywords,
            "color_palette": brief.color_palette,
            "top_tags": brief.top_tags,
            "print_style": brief.print_style,
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
    if screen_print:
        _reject_screen_print_forbidden(flux)
        _require_screen_print_terms(flux)

    return flux

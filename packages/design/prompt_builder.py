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

# Niches that demand a centered, isolated subject rather than wallpaper / abstract output.
# Matched whole-word against `niche` and `top_tags`.
SUBJECT_CENTRIC_KEYWORDS: tuple[str, ...] = (
    # Occupations
    "nurse", "teacher", "doctor", "engineer", "firefighter", "lawyer",
    "pilot", "chef", "mechanic", "electrician", "paramedic", "welder",
    "barber", "librarian", "pharmacist", "accountant", "realtor", "farmer",
    "trucker", "coach",
    # Identity / relationship
    "mom", "dad", "mama", "papa", "grandma", "grandpa", "grandmother",
    "grandfather", "auntie", "uncle", "wife", "husband", "bride", "groom",
    "dog mom", "cat dad", "cat mom", "dog dad", "plant parent",
    "bonus mom", "step dad",
    # Hobbies
    "fishing", "hunting", "camping", "hiking", "knitting", "crochet",
    "quilting", "gardening", "yoga", "running", "cycling", "golf",
    "tennis", "pickleball", "bowling", "chess", "gaming", "birding",
    "astronomy", "baking",
    # Life stage
    "retiree", "retired", "graduate", "graduation", "student", "senior",
    "freshman", "newlywed", "birthday",
)

REQUIRED_SUBJECT_TERMS: tuple[str, ...] = (
    "centered illustration",
    "single subject",
    "isolated on plain background",
    "clear focal point",
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


def build_flux_prompt(brief: TrendBrief) -> FluxPrompt:
    settings = get_settings()
    client = Anthropic(api_key=settings.anthropic_api_key)

    subject_centric = is_subject_centric_brief(brief)
    system_text = SYSTEM_PROMPT + SUBJECT_CENTRIC_RULES if subject_centric else SYSTEM_PROMPT

    user_content = json.dumps(
        {
            "niche": brief.niche,
            "style_keywords": brief.style_keywords,
            "color_palette": brief.color_palette,
            "top_tags": brief.top_tags,
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

    if subject_centric:
        _require_subject_terms(flux)

    return flux

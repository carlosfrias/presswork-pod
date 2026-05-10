import json

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


def build_flux_prompt(brief: TrendBrief) -> FluxPrompt:
    settings = get_settings()
    client = Anthropic(api_key=settings.anthropic_api_key)

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
                "text": SYSTEM_PROMPT,
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

    return FluxPrompt.model_validate(data)

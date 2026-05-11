import json

from anthropic import AsyncAnthropic

from packages.shared_py.config import get_settings
from packages.shared_py.models import ClaudeAnalysis

SYSTEM_PROMPT = """You are a print-on-demand market analyst.
Given raw Etsy listing data, extract a structured trend brief.
Respond ONLY with valid JSON matching this schema:
{
  "niche": str,
  "style_keywords": [str],  // aesthetic descriptors, NOT brand names
  "top_tags": [str],        // 13 max, Etsy tag format
  "price_target_usd": float,
  "color_palette": [str]    // hex or color names
}
Never reference specific shop names, artist names, or existing IP."""


def _slim_listings(listings: list[dict]) -> list[dict]:
    return [
        {
            "title": listing.get("title"),
            "tags": listing.get("tags"),
            "price": listing.get("price", {}).get("amount"),
            "num_reviews": listing.get("num_reviews"),
        }
        for listing in listings
    ]


async def analyze_niche(raw_listings: list[dict]) -> ClaudeAnalysis:
    settings = get_settings()
    client = AsyncAnthropic(api_key=settings.anthropic_api_key)

    response = await client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=1024,
        system=[
            {
                "type": "text",
                "text": SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[
            {
                "role": "user",
                "content": json.dumps(_slim_listings(raw_listings), indent=2),
            }
        ],
    )

    first_block = response.content[0]
    if first_block.type != "text":
        raise ValueError(f"Claude returned unexpected block type: {first_block.type}")
    raw_text = first_block.text
    try:
        data = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Claude returned invalid JSON: {raw_text!r}") from exc

    return ClaudeAnalysis.model_validate(data)

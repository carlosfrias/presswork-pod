import json

from anthropic import AsyncAnthropic

from packages.shared_py.config import get_settings
from packages.shared_py.models import ClaudeAnalysis

SYSTEM_PROMPT = """You are a print-on-demand market analyst.
Given raw Etsy listing data, extract a structured trend brief.
Each listing in the input has price_usd in dollars (e.g. 24.99), already converted from Etsy's cents amount.
Respond ONLY with valid JSON matching this schema:
{
  "niche": str,
  "style_keywords": [str],  // aesthetic descriptors, NOT brand names
  "top_tags": [str],        // 13 max, Etsy tag format
  "price_target_usd": float,
  "color_palette": [str],   // hex or color names
  "print_style": "screen_print" | "full_color"
}
print_style classification rules:
- "screen_print" when the niche/style signals a one-color, single-ink design:
  vinyl decal, screen-print tee, bold silhouette, vintage typography, retro
  varsity, line-art logo, monochrome graphic, sticker-style sticker pack. These
  designs print as one solid ink color with no gradients or shading.
- "full_color" when the niche signals photographic, watercolor, painterly,
  multi-color illustration, gradient, or any design that needs tonal range
  (e.g. watercolor florals, photo-realistic pets, full-color cartoons).
- When in doubt, choose "full_color" — it is the safer default and matches the
  current pipeline's existing behavior.
Never reference specific shop names, artist names, or existing IP."""


def _slim_listings(listings: list[dict]) -> list[dict]:
    # Etsy returns price.amount in CENTS (e.g. 2499 = $24.99). Convert to USD
    # before sending to Claude — passing raw cents was producing wildly wrong
    # price_target_usd values (audit #46).
    out: list[dict] = []
    for listing in listings:
        amount_cents = (listing.get("price") or {}).get("amount")
        price_usd = round(amount_cents / 100, 2) if amount_cents is not None else None
        out.append(
            {
                "title": listing.get("title"),
                "tags": listing.get("tags"),
                "price_usd": price_usd,
                "num_reviews": listing.get("num_reviews"),
            }
        )
    return out


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

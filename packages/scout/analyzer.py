import json
import re

import anthropic
import structlog
from anthropic import AsyncAnthropic

from packages.shared_py.config import get_settings
from packages.shared_py.models import ClaudeAnalysis

log = structlog.get_logger(__name__)


def _strip_code_fences(text: str) -> str:
    """Extract JSON from a Markdown code fence Claude sometimes wraps it in.

    Handles a leading prose preamble before the fence (e.g. "Here is the
    analysis:\\n```json\\n{...}\\n```"), a plain ``` fence, or bare JSON with no
    fence at all.  The regex searches anywhere in the response so position of the
    fence does not matter.
    """
    stripped = text.strip()
    # Require the closing fence on its own line (``\n```\``) rather than ``\n?```\``
    # so a literal ``` sequence *inside* a JSON value cannot terminate the match
    # early and truncate the payload.
    m = re.search(r"```(?:json)?\s*\n([\s\S]*?)\n```", stripped)
    if m:
        # Claude was told to emit raw JSON (see SYSTEM_PROMPT); log when it
        # disobeys so we can track how often this fallback path is exercised.
        log.warning("scout_claude_fenced_response", action="strip_code_fences")
        return m.group(1).strip()
    return stripped


# How many listings per niche send their thumbnail to Claude. Etsy already
# returns score-sorted, so we slice the top N. Cap bounds token cost.
SCOUT_VISION_MAX_IMAGES = 12
# Etsy CDN size variant to send. 570xN is the smallest that preserves enough
# detail for Claude to read color/style; smaller variants (url_300x300)
# sometimes show heavy compression artifacts on detailed designs.
SCOUT_VISION_THUMBNAIL_FIELD = "url_570xN"

SYSTEM_PROMPT = """You are a print-on-demand market analyst.
Given raw Etsy listing data, extract a structured trend brief.
Each listing in the input has price_usd in dollars (e.g. 24.99), already converted from Etsy's cents amount.
Respond ONLY with valid JSON matching this schema:
{
  "niche": str,
  "style_keywords": [str],  // aesthetic descriptors, NOT brand names
  "top_tags": [str],        // 13 max, Etsy tag format
  "price_target_usd": float,
  "color_palette": [str]    // hex or color names
}
Never reference specific shop names, artist names, or existing IP.
Respond with raw JSON only — do NOT wrap the output in Markdown code fences or add any commentary before or after the JSON."""

VISION_SYSTEM_ADDENDUM = """

When images are provided, prefer evidence from the images over the metadata for
style_keywords and color_palette. The metadata is a starting hint; the images
are ground truth. If the images conflict with title/tag wording (e.g. tag says
"vintage" but the design is a flat modern vector), trust the image."""


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


def _pick_thumbnail_url(listing: dict) -> str | None:
    images = listing.get("images") or []
    if not images:
        return None
    first = images[0]
    return first.get(SCOUT_VISION_THUMBNAIL_FIELD) or first.get("url_fullxfull")


def _build_vision_content(raw_listings: list[dict]) -> list[dict]:
    slim = _slim_listings(raw_listings)
    blocks: list[dict] = [
        {
            "type": "text",
            "text": (
                "Below are the top Etsy listings for this niche. For each listing "
                "you will see its metadata followed by its primary thumbnail. Use "
                "the IMAGES as the primary source for style_keywords and color_palette; "
                "use titles/tags for niche framing and top_tags extraction. "
                "Respond with the structured JSON described in the system prompt."
            ),
        }
    ]
    for i, (slim_listing, raw_listing) in enumerate(
        zip(slim, raw_listings[: len(slim)], strict=False)
    ):
        thumb_url = _pick_thumbnail_url(raw_listing)
        blocks.append({"type": "text", "text": f"Listing {i}: {json.dumps(slim_listing)}"})
        if thumb_url is not None:
            blocks.append({"type": "image", "source": {"type": "url", "url": thumb_url}})
        if i + 1 >= SCOUT_VISION_MAX_IMAGES:
            break
    return blocks


async def analyze_niche(raw_listings: list[dict]) -> ClaudeAnalysis:
    settings = get_settings()
    client = AsyncAnthropic(api_key=settings.anthropic_api_key)

    # runtime_flags overrides the env default — the dashboard toggle should
    # actually do something. Falls back to settings.scout_vision_enabled on
    # missing row or read error.
    from packages.shared_py.runtime_flags import get_runtime_flag  # noqa: PLC0415

    vision_enabled = get_runtime_flag("scout_vision_enabled", settings.scout_vision_enabled)
    if vision_enabled:
        user_content: str | list[dict] = _build_vision_content(raw_listings)
        system_text = SYSTEM_PROMPT + VISION_SYSTEM_ADDENDUM
    else:
        user_content = json.dumps(_slim_listings(raw_listings), indent=2)
        system_text = SYSTEM_PROMPT

    async def _create(content: str | list[dict], system: str):
        return await client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=1024,
            system=[
                {
                    "type": "text",
                    "text": system,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            messages=[{"role": "user", "content": content}],
        )

    try:
        response = await _create(user_content, system_text)
    except anthropic.BadRequestError as exc:
        # Best-effort fallback: a single bad image URL for one niche shouldn't
        # kill the whole run. Degrade to text-only and log so we can see how
        # often this fires.
        if vision_enabled and "image" in str(exc).lower():
            log.warning(
                "scout_vision_fallback",
                action="scout_vision_fallback",
                error=str(exc),
                status="degraded",
            )
            response = await _create(
                json.dumps(_slim_listings(raw_listings), indent=2),
                SYSTEM_PROMPT,
            )
        else:
            raise

    # Best-effort consumption log for the dashboard. Never block the agent on a
    # metrics failure (record_usage swallows exceptions internally).
    from packages.shared_py.llm_usage import (  # noqa: PLC0415 — avoid cold-start cost in CI tests
        estimate_anthropic_cost_usd,
        record_usage,
    )

    usage = getattr(response, "usage", None)
    if usage is not None:
        record_usage(
            agent="scout",
            provider="anthropic",
            operation="analyze_niche",
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
                "vision_enabled": vision_enabled,
            },
        )

    first_block = response.content[0]
    if first_block.type != "text":
        raise ValueError(f"Claude returned unexpected block type: {first_block.type}")
    raw_text = first_block.text
    try:
        data = json.loads(_strip_code_fences(raw_text))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Claude returned invalid JSON: {raw_text!r}") from exc

    return ClaudeAnalysis.model_validate(data)

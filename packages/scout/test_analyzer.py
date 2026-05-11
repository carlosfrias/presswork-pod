import json
from unittest.mock import AsyncMock, MagicMock

import pytest
from pydantic import ValidationError

from packages.scout.analyzer import analyze_niche
from packages.shared_py.models import ClaudeAnalysis

_VALID_ANALYSIS = {
    "niche": "dog mom gifts",
    "style_keywords": ["playful", "illustrated", "warm"],
    "top_tags": ["dog mom", "dog lover gift", "fur mama"],
    "price_target_usd": 24.99,
    "color_palette": ["#3D5AFE", "white", "tan"],
}

# price.amount is in CENTS per Etsy's API (2499 = $24.99). _slim_listings
# converts to USD before sending to Claude.
_SAMPLE_LISTINGS = [
    {"title": "Dog Mom Shirt", "tags": ["dog mom"], "price": {"amount": 2499}, "num_reviews": 42}
]


@pytest.fixture(autouse=True)
def mock_settings(mocker):
    s = MagicMock()
    s.anthropic_api_key = "test-key"
    mocker.patch("packages.scout.analyzer.get_settings", return_value=s)


def _mock_client(mocker, response_text: str) -> MagicMock:
    block = MagicMock()
    block.type = "text"
    block.text = response_text
    message = MagicMock()
    message.content = [block]
    client = MagicMock()
    client.messages.create = AsyncMock(return_value=message)
    mocker.patch("packages.scout.analyzer.AsyncAnthropic", return_value=client)
    return client


@pytest.mark.asyncio
async def test_valid_response_parses_to_claude_analysis(mocker):
    _mock_client(mocker, json.dumps(_VALID_ANALYSIS))
    result = await analyze_niche(_SAMPLE_LISTINGS)
    assert isinstance(result, ClaudeAnalysis)
    assert result.niche == "dog mom gifts"
    assert result.price_target_usd == 24.99


@pytest.mark.asyncio
async def test_invalid_json_raises_value_error(mocker):
    _mock_client(mocker, "here is my analysis: sorry, not JSON")
    with pytest.raises(ValueError, match="invalid JSON"):
        await analyze_niche(_SAMPLE_LISTINGS)


@pytest.mark.asyncio
async def test_more_than_13_tags_raises_validation_error(mocker):
    bad = {**_VALID_ANALYSIS, "top_tags": [f"tag-{i}" for i in range(14)]}
    _mock_client(mocker, json.dumps(bad))
    with pytest.raises(ValidationError):
        await analyze_niche(_SAMPLE_LISTINGS)


@pytest.mark.asyncio
async def test_system_prompt_has_cache_control(mocker):
    client = _mock_client(mocker, json.dumps(_VALID_ANALYSIS))
    await analyze_niche(_SAMPLE_LISTINGS)
    kwargs = client.messages.create.call_args.kwargs
    system_blocks = kwargs["system"]
    assert any(block.get("cache_control") == {"type": "ephemeral"} for block in system_blocks)


def test_slim_listings_converts_cents_to_usd():
    """Audit #46: Etsy returns price.amount in cents (2499). The slim payload
    sent to Claude must be USD (24.99) so price_target_usd isn't off by 100x."""
    from packages.scout.analyzer import _slim_listings

    listings = [
        {"title": "A", "tags": [], "price": {"amount": 2499}, "num_reviews": 0},
        {"title": "B", "tags": [], "price": {"amount": 1099}, "num_reviews": 0},
        {"title": "C", "tags": [], "price": None, "num_reviews": 0},
    ]
    out = _slim_listings(listings)
    assert out[0]["price_usd"] == 24.99
    assert out[1]["price_usd"] == 10.99
    assert out[2]["price_usd"] is None
    # Old key removed.
    assert "price" not in out[0]

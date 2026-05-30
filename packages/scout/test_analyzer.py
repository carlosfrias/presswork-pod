import json
from unittest.mock import AsyncMock, MagicMock

import anthropic
import httpx
import pytest
from pydantic import ValidationError

from packages.scout.analyzer import _strip_code_fences, analyze_niche
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
    s.scout_vision_enabled = False
    mocker.patch("packages.scout.analyzer.get_settings", return_value=s)
    # analyzer.py now consults runtime_flags to override the env-default
    # vision toggle. In tests we want `mock_settings.scout_vision_enabled`
    # to remain authoritative, so return the fallback the caller passes in
    # (which is settings.scout_vision_enabled at the call site).
    # Imported inside analyzer.py via a deferred import, so we have to patch
    # at the source module — packages.shared_py.runtime_flags.get_runtime_flag.
    mocker.patch(
        "packages.shared_py.runtime_flags.get_runtime_flag",
        side_effect=lambda _key, fallback: fallback,
    )
    return s


def _mock_client(
    mocker,
    response_text: str,
    *,
    first_call_error: Exception | None = None,
) -> MagicMock:
    """Mock the Anthropic client.

    If first_call_error is provided, the first messages.create call raises it
    and the second returns the parsed response — lets tests exercise the
    vision-to-text fallback path.
    """
    block = MagicMock()
    block.type = "text"
    block.text = response_text
    message = MagicMock()
    message.content = [block]
    client = MagicMock()
    if first_call_error is None:
        client.messages.create = AsyncMock(return_value=message)
    else:
        client.messages.create = AsyncMock(side_effect=[first_call_error, message])
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
async def test_fenced_json_response_is_parsed(mocker):
    """Claude intermittently wraps JSON in a ```json fence — strip it, don't fail."""
    fenced = f"```json\n{json.dumps(_VALID_ANALYSIS)}\n```"
    _mock_client(mocker, fenced)
    result = await analyze_niche(_SAMPLE_LISTINGS)
    assert isinstance(result, ClaudeAnalysis)
    assert result.niche == "dog mom gifts"


@pytest.mark.asyncio
async def test_fenced_json_with_preamble_is_parsed(mocker):
    """Prose preamble before the ```json fence must not break parsing."""
    fenced = f"Here is the analysis:\n```json\n{json.dumps(_VALID_ANALYSIS)}\n```"
    _mock_client(mocker, fenced)
    result = await analyze_niche(_SAMPLE_LISTINGS)
    assert isinstance(result, ClaudeAnalysis)
    assert result.niche == "dog mom gifts"


def test_strip_code_fences_preserves_inline_backticks():
    """A literal ``` inside a JSON value must not terminate the fence early.

    The closing fence must sit on its own line, so a backtick run embedded in a
    string value is kept intact and the JSON round-trips cleanly.
    """
    payload = {"niche": "code humor", "note": "use ``` for blocks"}
    fenced = f"```json\n{json.dumps(payload)}\n```"
    extracted = _strip_code_fences(fenced)
    assert json.loads(extracted)["note"] == "use ``` for blocks"


def test_strip_code_fences_passes_through_bare_json():
    """Responses with no fence fall through unchanged."""
    bare = json.dumps(_VALID_ANALYSIS)
    assert _strip_code_fences(bare) == bare


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


@pytest.mark.asyncio
async def test_vision_disabled_sends_text_only(mocker, mock_settings):
    mock_settings.scout_vision_enabled = False
    client = _mock_client(mocker, json.dumps(_VALID_ANALYSIS))
    listings_with_images = [
        {
            **_SAMPLE_LISTINGS[0],
            "images": [{"url_570xN": "https://i.etsystatic.com/x.jpg"}],
        }
    ]
    await analyze_niche(listings_with_images)
    kwargs = client.messages.create.call_args.kwargs
    content = kwargs["messages"][0]["content"]
    assert isinstance(content, str)
    assert "image" not in content.lower()  # no image blocks injected


@pytest.mark.asyncio
async def test_vision_enabled_includes_image_blocks(mocker, mock_settings):
    mock_settings.scout_vision_enabled = True
    client = _mock_client(mocker, json.dumps(_VALID_ANALYSIS))
    listings_with_images = [
        {
            **_SAMPLE_LISTINGS[0],
            "images": [{"url_570xN": "https://i.etsystatic.com/x.jpg"}],
        }
    ]
    await analyze_niche(listings_with_images)
    kwargs = client.messages.create.call_args.kwargs
    content = kwargs["messages"][0]["content"]
    assert isinstance(content, list)
    image_blocks = [b for b in content if b.get("type") == "image"]
    assert len(image_blocks) == 1
    assert image_blocks[0]["source"] == {
        "type": "url",
        "url": "https://i.etsystatic.com/x.jpg",
    }
    # System prompt addendum applied.
    system_text = kwargs["system"][0]["text"]
    assert "ground truth" in system_text


@pytest.mark.asyncio
async def test_vision_falls_back_to_text_on_image_bad_request(mocker, mock_settings):
    mock_settings.scout_vision_enabled = True
    err = anthropic.BadRequestError(
        message="Could not fetch image at url",
        response=httpx.Response(400, request=httpx.Request("POST", "https://x")),
        body=None,
    )
    client = _mock_client(mocker, json.dumps(_VALID_ANALYSIS), first_call_error=err)
    listings_with_images = [
        {
            **_SAMPLE_LISTINGS[0],
            "images": [{"url_570xN": "https://broken.example/x.jpg"}],
        }
    ]
    result = await analyze_niche(listings_with_images)
    assert isinstance(result, ClaudeAnalysis)
    # Two calls: vision attempt (failed) + text-only retry.
    assert client.messages.create.await_count == 2
    second_call_kwargs = client.messages.create.call_args_list[1].kwargs
    assert isinstance(second_call_kwargs["messages"][0]["content"], str)


@pytest.mark.asyncio
async def test_listing_with_no_images_sends_text_only_block(mocker, mock_settings):
    mock_settings.scout_vision_enabled = True
    client = _mock_client(mocker, json.dumps(_VALID_ANALYSIS))
    mixed = [
        {**_SAMPLE_LISTINGS[0], "images": [{"url_570xN": "https://i.etsystatic.com/a.jpg"}]},
        {**_SAMPLE_LISTINGS[0]},  # no images key
    ]
    await analyze_niche(mixed)
    kwargs = client.messages.create.call_args.kwargs
    content = kwargs["messages"][0]["content"]
    image_blocks = [b for b in content if b.get("type") == "image"]
    text_listing_blocks = [
        b for b in content if b.get("type") == "text" and b.get("text", "").startswith("Listing ")
    ]
    # Two listings → two text blocks; only one image block (second had no images).
    assert len(text_listing_blocks) == 2
    assert len(image_blocks) == 1


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

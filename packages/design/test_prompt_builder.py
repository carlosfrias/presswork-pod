import json
from datetime import UTC, datetime
from unittest.mock import MagicMock
from uuid import uuid4

import pytest
from pydantic import ValidationError

from packages.design.prompt_builder import build_flux_prompt
from packages.shared_py.models import FluxPrompt, TrendBrief

_VALID_PROMPT = {
    "prompt": "print on demand design, transparent background, high resolution, vector-style mountain sunrise",
    "negative_prompt": "blurry, low quality",
    "style_descriptors": ["minimalist", "nature", "warm tones"],
}

_NOW = datetime(2026, 1, 1, tzinfo=UTC)

_SAMPLE_BRIEF = TrendBrief(
    id=uuid4(),
    created_at=_NOW,
    updated_at=_NOW,
    status="processing",
    niche="mountain hiking",
    style_keywords=["minimalist", "nature", "adventure"],
    color_palette=["forest green", "burnt orange", "cream"],
    top_tags=["hiking gift", "mountain lover", "outdoor life"],
)


@pytest.fixture(autouse=True)
def mock_settings(mocker):
    s = MagicMock()
    s.anthropic_api_key = "test-key"
    mocker.patch("packages.design.prompt_builder.get_settings", return_value=s)


def _mock_client(mocker, response_text: str) -> MagicMock:
    block = MagicMock()
    block.type = "text"
    block.text = response_text
    message = MagicMock()
    message.content = [block]
    client = MagicMock()
    client.messages.create.return_value = message
    mocker.patch("packages.design.prompt_builder.Anthropic", return_value=client)
    return client


def test_valid_response_parses_to_flux_prompt(mocker):
    _mock_client(mocker, json.dumps(_VALID_PROMPT))
    result = build_flux_prompt(_SAMPLE_BRIEF)
    assert isinstance(result, FluxPrompt)
    assert "transparent background" in result.prompt
    assert result.style_descriptors == ["minimalist", "nature", "warm tones"]


def test_banned_artist_name_raises_validation_error(mocker):
    bad = {**_VALID_PROMPT, "prompt": _VALID_PROMPT["prompt"] + " banksy style"}
    _mock_client(mocker, json.dumps(bad))
    with pytest.raises(ValidationError, match="disallowed term"):
        build_flux_prompt(_SAMPLE_BRIEF)


def test_missing_required_flux_term_raises_validation_error(mocker):
    bad = {**_VALID_PROMPT, "prompt": "a mountain scene without the required boilerplate"}
    _mock_client(mocker, json.dumps(bad))
    with pytest.raises(ValidationError, match="required FLUX term"):
        build_flux_prompt(_SAMPLE_BRIEF)


def test_invalid_json_raises_value_error(mocker):
    _mock_client(mocker, "not valid json at all")
    with pytest.raises(ValueError, match="invalid JSON"):
        build_flux_prompt(_SAMPLE_BRIEF)


def test_system_prompt_has_cache_control(mocker):
    client = _mock_client(mocker, json.dumps(_VALID_PROMPT))
    build_flux_prompt(_SAMPLE_BRIEF)
    kwargs = client.messages.create.call_args.kwargs
    system_blocks = kwargs["system"]
    assert any(
        block.get("cache_control") == {"type": "ephemeral"}
        for block in system_blocks
    )

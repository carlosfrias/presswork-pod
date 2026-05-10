import json
from datetime import UTC, datetime
from unittest.mock import MagicMock
from uuid import uuid4

import pytest
from pydantic import ValidationError

from packages.design.prompt_builder import (
    SUBJECT_CENTRIC_RULES,
    build_flux_prompt,
    is_subject_centric_brief,
)
from packages.shared_py.models import FluxPrompt, TrendBrief

_VALID_PROMPT = {
    "prompt": "print on demand design, transparent background, high resolution, vector-style mountain sunrise",
    "negative_prompt": "blurry, low quality",
    "style_descriptors": ["minimalist", "nature", "warm tones"],
}

_SUBJECT_VALID_PROMPT = {
    "prompt": (
        "print on demand design, transparent background, high resolution, vector-style "
        "centered illustration of a single subject — a stethoscope and heart icon — "
        "isolated on plain background with a clear focal point"
    ),
    "negative_prompt": "blurry, low quality, repeating pattern",
    "style_descriptors": ["minimalist", "medical", "warm tones"],
}

_NOW = datetime(2026, 1, 1, tzinfo=UTC)

_SAMPLE_BRIEF = TrendBrief(
    id=uuid4(),
    created_at=_NOW,
    updated_at=_NOW,
    status="processing",
    niche="abstract botanical wall art",
    style_keywords=["minimalist", "nature", "boho"],
    color_palette=["forest green", "burnt orange", "cream"],
    top_tags=["wall art print", "botanical decor", "boho home"],
)

_NURSE_BRIEF = TrendBrief(
    id=uuid4(),
    created_at=_NOW,
    updated_at=_NOW,
    status="processing",
    niche="nurse appreciation gifts",
    style_keywords=["minimalist", "warm", "professional"],
    color_palette=["teal", "blush", "cream"],
    top_tags=["nurse gift", "rn life", "healthcare worker"],
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


# --- Subject-centric detection ----------------------------------------------


@pytest.mark.parametrize(
    "niche,top_tags,expected",
    [
        ("nurse appreciation gifts", ["rn life"], True),
        ("dog mom", ["fur mom", "pet lover"], True),
        ("retired teacher", ["retirement gift"], True),
        ("yoga studio decor", [], True),  # 'yoga' hit
        ("abstract botanical wall art", ["wall art print", "boho decor"], False),
        ("vintage typography", ["typography print"], False),
        ("mid-century geometric", ["modern decor"], False),
    ],
)
def test_is_subject_centric_brief_classification(niche, top_tags, expected):
    brief = TrendBrief(
        id=uuid4(),
        created_at=_NOW,
        updated_at=_NOW,
        status="processing",
        niche=niche,
        top_tags=top_tags or None,
    )
    assert is_subject_centric_brief(brief) is expected


# --- System-prompt branching -------------------------------------------------


def test_subject_centric_brief_appends_subject_rules_to_system_prompt(mocker):
    client = _mock_client(mocker, json.dumps(_SUBJECT_VALID_PROMPT))
    build_flux_prompt(_NURSE_BRIEF)
    kwargs = client.messages.create.call_args.kwargs
    system_text = kwargs["system"][0]["text"]
    assert SUBJECT_CENTRIC_RULES.strip() in system_text
    assert "centered illustration" in system_text
    assert "single subject" in system_text


def test_non_subject_centric_brief_does_not_append_subject_rules(mocker):
    client = _mock_client(mocker, json.dumps(_VALID_PROMPT))
    build_flux_prompt(_SAMPLE_BRIEF)
    kwargs = client.messages.create.call_args.kwargs
    system_text = kwargs["system"][0]["text"]
    assert SUBJECT_CENTRIC_RULES.strip() not in system_text


# --- Post-generation validator ----------------------------------------------


def test_subject_centric_brief_rejects_prompt_missing_required_terms(mocker):
    # Same generic prompt that passes for non-subject-centric briefs must FAIL here.
    _mock_client(mocker, json.dumps(_VALID_PROMPT))
    with pytest.raises(ValueError, match="missing required subject-centered phrasing"):
        build_flux_prompt(_NURSE_BRIEF)


def test_subject_centric_brief_accepts_prompt_with_all_required_terms(mocker):
    _mock_client(mocker, json.dumps(_SUBJECT_VALID_PROMPT))
    result = build_flux_prompt(_NURSE_BRIEF)
    assert isinstance(result, FluxPrompt)
    assert "centered illustration" in result.prompt


def test_enforcement_is_conditional_not_global(mocker):
    # The exact same Claude response that fails for nurse passes for abstract wall art.
    _mock_client(mocker, json.dumps(_VALID_PROMPT))
    result = build_flux_prompt(_SAMPLE_BRIEF)
    assert isinstance(result, FluxPrompt)

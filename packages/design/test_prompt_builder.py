import json
from datetime import UTC, datetime
from unittest.mock import MagicMock
from uuid import uuid4

import pytest
from pydantic import ValidationError

from packages.design.prompt_builder import (
    SCREEN_PRINT_RULES,
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


# Bug #25: the FluxPrompt no_banned_names validator was removed (theater — a
# 5-name substring blocklist could not credibly police IP). Compliance is now
# enforced by the copywriter system prompt and validateCopyCompliance, both
# downstream. This test is intentionally left in place as a marker.
def test_banned_artist_name_passes_through_at_flux_level(mocker):
    bad = {**_VALID_PROMPT, "prompt": _VALID_PROMPT["prompt"] + " banksy style"}
    _mock_client(mocker, json.dumps(bad))
    # No longer raises at the FluxPrompt model boundary; compliance is enforced
    # upstream (copywriter) and downstream (validateCopyCompliance).
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
    assert any(block.get("cache_control") == {"type": "ephemeral"} for block in system_blocks)


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


# --- Anti-abstract / anti-wallpaper enforcement ------------------------------


def test_base_system_prompt_includes_anti_abstract_rules(mocker):
    client = _mock_client(mocker, json.dumps(_VALID_PROMPT))
    build_flux_prompt(_SAMPLE_BRIEF)
    kwargs = client.messages.create.call_args.kwargs
    system_text = kwargs["system"][0]["text"].lower()
    assert "wallpaper" in system_text
    assert "focal subject" in system_text


@pytest.mark.parametrize(
    "bad_term",
    [
        "wallpaper pattern",
        "all-over floral",
        "seamless pattern",
        "tileable design",
        "color field",
        "gradient wash",
    ],
)
def test_abstract_phrasing_in_prompt_is_rejected(mocker, bad_term):
    bad = {**_VALID_PROMPT, "prompt": _VALID_PROMPT["prompt"] + " " + bad_term}
    _mock_client(mocker, json.dumps(bad))
    with pytest.raises(ValueError, match="forbidden abstract/wallpaper phrasing"):
        build_flux_prompt(_SAMPLE_BRIEF)


def test_abstract_phrasing_in_style_descriptors_is_rejected(mocker):
    bad = {**_VALID_PROMPT, "style_descriptors": ["minimalist", "color field", "muted"]}
    _mock_client(mocker, json.dumps(bad))
    with pytest.raises(ValueError, match="forbidden abstract/wallpaper phrasing"):
        build_flux_prompt(_SAMPLE_BRIEF)


def test_abstract_phrasing_in_negative_prompt_is_allowed(mocker):
    # Negative prompt is the correct place to tell FLUX what to avoid.
    ok = {
        **_VALID_PROMPT,
        "negative_prompt": "wallpaper pattern, repeating motif, color field, tileable",
    }
    _mock_client(mocker, json.dumps(ok))
    result = build_flux_prompt(_SAMPLE_BRIEF)
    assert isinstance(result, FluxPrompt)
    assert "wallpaper" in (result.negative_prompt or "")


def test_anti_abstract_rule_applies_to_subject_centric_briefs_too(mocker):
    bad = {
        **_SUBJECT_VALID_PROMPT,
        "prompt": _SUBJECT_VALID_PROMPT["prompt"] + " on a tileable wallpaper background",
    }
    _mock_client(mocker, json.dumps(bad))
    with pytest.raises(ValueError, match="forbidden abstract/wallpaper phrasing"):
        build_flux_prompt(_NURSE_BRIEF)


# --- Screen-print mode ------------------------------------------------------


_SCREEN_PRINT_BRIEF = TrendBrief(
    id=uuid4(),
    created_at=_NOW,
    updated_at=_NOW,
    status="processing",
    niche="vintage motorcycle silhouette tee",
    style_keywords=["retro", "bold", "monochrome"],
    color_palette=["black"],
    top_tags=["motorcycle tee", "biker shirt", "vintage moto"],
    print_style="screen_print",
)

_SCREEN_PRINT_VALID_PROMPT = {
    "prompt": (
        "print on demand design, transparent background, high resolution, vector-style "
        "bold vector-style screen print of a vintage motorcycle silhouette in a single ink color, "
        "solid shapes, no gradients, no halftones, no shading, isolated on a clean background"
    ),
    "negative_prompt": "gradient, halftone, shading, photorealistic, blurry",
    "style_descriptors": ["retro", "bold", "monochrome"],
}


def test_screen_print_brief_appends_screen_print_rules(mocker):
    client = _mock_client(mocker, json.dumps(_SCREEN_PRINT_VALID_PROMPT))
    build_flux_prompt(_SCREEN_PRINT_BRIEF)
    kwargs = client.messages.create.call_args.kwargs
    system_text = kwargs["system"][0]["text"]
    assert SCREEN_PRINT_RULES.strip() in system_text
    assert "single ink color" in system_text
    assert "bold vector-style screen print" in system_text


def test_non_screen_print_brief_does_not_append_screen_print_rules(mocker):
    client = _mock_client(mocker, json.dumps(_VALID_PROMPT))
    build_flux_prompt(_SAMPLE_BRIEF)  # print_style is None
    kwargs = client.messages.create.call_args.kwargs
    system_text = kwargs["system"][0]["text"]
    assert SCREEN_PRINT_RULES.strip() not in system_text


def test_screen_print_brief_rejects_prompt_missing_required_terms(mocker):
    # Generic prompt that passes for non-screen-print briefs must FAIL here.
    _mock_client(mocker, json.dumps(_VALID_PROMPT))
    with pytest.raises(ValueError, match="missing required screen-print phrasing"):
        build_flux_prompt(_SCREEN_PRINT_BRIEF)


def test_screen_print_brief_accepts_prompt_with_all_required_terms(mocker):
    _mock_client(mocker, json.dumps(_SCREEN_PRINT_VALID_PROMPT))
    result = build_flux_prompt(_SCREEN_PRINT_BRIEF)
    assert isinstance(result, FluxPrompt)
    assert "single ink color" in result.prompt


@pytest.mark.parametrize("bad_term", ["gradient", "halftone", "shading", "color blend"])
def test_screen_print_rejects_tonal_phrasing_in_prompt(mocker, bad_term):
    bad = {
        **_SCREEN_PRINT_VALID_PROMPT,
        "prompt": _SCREEN_PRINT_VALID_PROMPT["prompt"] + " with subtle " + bad_term,
    }
    _mock_client(mocker, json.dumps(bad))
    with pytest.raises(ValueError, match="tonal phrasing incompatible with screen_print"):
        build_flux_prompt(_SCREEN_PRINT_BRIEF)


def test_tonal_phrasing_allowed_in_full_color_prompt(mocker):
    """Same word ("gradient") that fails screen_print is accepted for full_color.
    Guards against regressing to a global forbidden list.
    """
    ok = {**_VALID_PROMPT, "prompt": _VALID_PROMPT["prompt"] + " with a soft gradient sky"}
    _mock_client(mocker, json.dumps(ok))
    result = build_flux_prompt(_SAMPLE_BRIEF)
    assert isinstance(result, FluxPrompt)


def test_tonal_phrasing_allowed_in_screen_print_negative_prompt(mocker):
    """negative_prompt is the right place to tell FLUX to avoid gradients —
    forbidden terms in the positive prompt fail, but in the negative prompt they pass.
    """
    ok = {
        **_SCREEN_PRINT_VALID_PROMPT,
        "negative_prompt": "gradient, halftone, shading, color blend, photorealistic",
    }
    _mock_client(mocker, json.dumps(ok))
    result = build_flux_prompt(_SCREEN_PRINT_BRIEF)
    assert isinstance(result, FluxPrompt)
    assert "gradient" in (result.negative_prompt or "")


def test_subject_centric_and_screen_print_compose(mocker):
    """A brief can be both subject-centric AND screen_print (e.g. nurse silhouette tee).
    Both rule sets must apply.
    """
    brief = TrendBrief(
        id=uuid4(),
        created_at=_NOW,
        updated_at=_NOW,
        status="processing",
        niche="nurse silhouette screen print tee",
        style_keywords=["bold", "monochrome"],
        color_palette=["black"],
        top_tags=["nurse gift", "rn shirt"],
        print_style="screen_print",
    )
    combined_prompt = {
        "prompt": (
            "print on demand design, transparent background, high resolution, vector-style "
            "bold vector-style screen print of a centered illustration, single subject — "
            "a nurse silhouette — isolated on plain background with a clear focal point, "
            "single ink color, solid shapes, no gradients, no halftones, no shading"
        ),
        "negative_prompt": "gradient, halftone, shading",
        "style_descriptors": ["bold", "monochrome", "silhouette"],
    }
    client = _mock_client(mocker, json.dumps(combined_prompt))
    result = build_flux_prompt(brief)
    assert isinstance(result, FluxPrompt)
    kwargs = client.messages.create.call_args.kwargs
    system_text = kwargs["system"][0]["text"]
    assert SUBJECT_CENTRIC_RULES.strip() in system_text
    assert SCREEN_PRINT_RULES.strip() in system_text


def test_full_color_brief_is_default_when_print_style_none(mocker):
    """Bug guard: a brief with print_style=None must not trigger screen_print validators."""
    assert _SAMPLE_BRIEF.print_style is None
    _mock_client(mocker, json.dumps(_VALID_PROMPT))
    # If screen_print validators ran, this would fail (no 'single ink color' etc.)
    result = build_flux_prompt(_SAMPLE_BRIEF)
    assert isinstance(result, FluxPrompt)

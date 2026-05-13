import json
import re
from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest
from pydantic import ValidationError

from packages.design.prompt_builder import (
    SUBJECT_CENTRIC_RULES,
    build_flux_prompt,
    build_gpt_image_prompt,
    is_subject_centric_brief,
)
from packages.shared_py.models import FluxPrompt, ImagePrompt, TrendBrief

_VALID_PROMPT = {
    "prompt": "print on demand design, vector-style, white background mountain sunrise",
    "negative_prompt": "blurry, low quality",
    "style_descriptors": ["minimalist", "nature", "warm tones"],
}

_SUBJECT_VALID_PROMPT = {
    "prompt": (
        "print on demand design, vector-style, white background "
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
    # Native async client (AsyncAnthropic) — `messages.create` must be an
    # AsyncMock so `await client.messages.create(...)` resolves to the
    # message. The rest of the MagicMock surface stays as-is so tests can
    # still inspect ``client.messages.create.call_args``.
    client = MagicMock()
    client.messages.create = AsyncMock(return_value=message)
    mocker.patch("packages.design.prompt_builder.AsyncAnthropic", return_value=client)
    return client


async def test_valid_response_parses_to_flux_prompt(mocker):
    _mock_client(mocker, json.dumps(_VALID_PROMPT))
    result = await build_flux_prompt(_SAMPLE_BRIEF)
    assert isinstance(result, FluxPrompt)
    assert "white background" in result.prompt
    assert result.style_descriptors == ["minimalist", "nature", "warm tones"]


# Bug #25: the FluxPrompt no_banned_names validator was removed (theater — a
# 5-name substring blocklist could not credibly police IP). Compliance is now
# enforced by the copywriter system prompt and validateCopyCompliance, both
# downstream. This test is intentionally left in place as a marker.
async def test_banned_artist_name_passes_through_at_flux_level(mocker):
    bad = {**_VALID_PROMPT, "prompt": _VALID_PROMPT["prompt"] + " banksy style"}
    _mock_client(mocker, json.dumps(bad))
    await build_flux_prompt(_SAMPLE_BRIEF)


async def test_missing_required_flux_term_raises_validation_error(mocker):
    bad = {**_VALID_PROMPT, "prompt": "a mountain scene without the required boilerplate"}
    _mock_client(mocker, json.dumps(bad))
    with pytest.raises(ValidationError, match="required FLUX term"):
        await build_flux_prompt(_SAMPLE_BRIEF)


async def test_invalid_json_raises_value_error(mocker):
    _mock_client(mocker, "not valid json at all")
    with pytest.raises(ValueError, match="invalid JSON"):
        await build_flux_prompt(_SAMPLE_BRIEF)


async def test_system_prompt_has_cache_control(mocker):
    client = _mock_client(mocker, json.dumps(_VALID_PROMPT))
    await build_flux_prompt(_SAMPLE_BRIEF)
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
async def test_is_subject_centric_brief_classification(niche, top_tags, expected):
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


async def test_subject_centric_brief_appends_subject_rules_to_system_prompt(mocker):
    client = _mock_client(mocker, json.dumps(_SUBJECT_VALID_PROMPT))
    await build_flux_prompt(_NURSE_BRIEF)
    kwargs = client.messages.create.call_args.kwargs
    system_text = kwargs["system"][0]["text"]
    assert SUBJECT_CENTRIC_RULES.strip() in system_text
    assert "centered illustration" in system_text
    assert "single subject" in system_text


async def test_non_subject_centric_brief_does_not_append_subject_rules(mocker):
    client = _mock_client(mocker, json.dumps(_VALID_PROMPT))
    await build_flux_prompt(_SAMPLE_BRIEF)
    kwargs = client.messages.create.call_args.kwargs
    system_text = kwargs["system"][0]["text"]
    assert SUBJECT_CENTRIC_RULES.strip() not in system_text


# --- Post-generation validator ----------------------------------------------


async def test_subject_centric_brief_rejects_prompt_missing_required_terms(mocker):
    # Same generic prompt that passes for non-subject-centric briefs must FAIL here.
    _mock_client(mocker, json.dumps(_VALID_PROMPT))
    with pytest.raises(ValueError, match="missing required subject-centered phrasing"):
        await build_flux_prompt(_NURSE_BRIEF)


async def test_subject_centric_brief_accepts_prompt_with_all_required_terms(mocker):
    _mock_client(mocker, json.dumps(_SUBJECT_VALID_PROMPT))
    result = await build_flux_prompt(_NURSE_BRIEF)
    assert isinstance(result, FluxPrompt)
    assert "centered illustration" in result.prompt


async def test_enforcement_is_conditional_not_global(mocker):
    # The exact same Claude response that fails for nurse passes for abstract wall art.
    _mock_client(mocker, json.dumps(_VALID_PROMPT))
    result = await build_flux_prompt(_SAMPLE_BRIEF)
    assert isinstance(result, FluxPrompt)


# --- Anti-abstract / anti-wallpaper enforcement ------------------------------


async def test_base_system_prompt_includes_anti_abstract_rules(mocker):
    client = _mock_client(mocker, json.dumps(_VALID_PROMPT))
    await build_flux_prompt(_SAMPLE_BRIEF)
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
async def test_abstract_phrasing_in_prompt_is_rejected(mocker, bad_term):
    bad = {**_VALID_PROMPT, "prompt": _VALID_PROMPT["prompt"] + " " + bad_term}
    _mock_client(mocker, json.dumps(bad))
    with pytest.raises(ValueError, match="forbidden abstract/wallpaper phrasing"):
        await build_flux_prompt(_SAMPLE_BRIEF)


async def test_abstract_phrasing_in_style_descriptors_is_rejected(mocker):
    bad = {**_VALID_PROMPT, "style_descriptors": ["minimalist", "color field", "muted"]}
    _mock_client(mocker, json.dumps(bad))
    with pytest.raises(ValueError, match="forbidden abstract/wallpaper phrasing"):
        await build_flux_prompt(_SAMPLE_BRIEF)


async def test_abstract_phrasing_in_negative_prompt_is_allowed(mocker):
    # Negative prompt is the correct place to tell FLUX what to avoid.
    ok = {
        **_VALID_PROMPT,
        "negative_prompt": "wallpaper pattern, repeating motif, color field, tileable",
    }
    _mock_client(mocker, json.dumps(ok))
    result = await build_flux_prompt(_SAMPLE_BRIEF)
    assert isinstance(result, FluxPrompt)
    assert "wallpaper" in (result.negative_prompt or "")


async def test_anti_abstract_rule_applies_to_subject_centric_briefs_too(mocker):
    bad = {
        **_SUBJECT_VALID_PROMPT,
        "prompt": _SUBJECT_VALID_PROMPT["prompt"] + " on a tileable wallpaper background",
    }
    _mock_client(mocker, json.dumps(bad))
    with pytest.raises(ValueError, match="forbidden abstract/wallpaper phrasing"):
        await build_flux_prompt(_NURSE_BRIEF)


# --- Custom-prompt palette injection ----------------------------------------

# Regression: dashboard inject + dashboard regen both flow through the
# custom-prompt branch in build_flux_prompt / build_gpt_image_prompt. Prior to
# the fix those branches returned the operator's prompt verbatim, dropping the
# brief.color_palette entirely — so a fresh palette selection did nothing.

_CUSTOM_GPT_PROMPT = (
    "A single centered screen print of a frog knight. The knight has a very "
    "frog-like head, no real human expressiveness on it. It carries a large "
    "sword and wears armor. This is a character print study, strong silhouette."
)
_CUSTOM_FLUX_PROMPT = (
    "print on demand design, vector-style of a frog knight, white background, strong silhouette"
)


def _brief_with_custom(prompt: str, *, palette: list[str] | None, image_model: str) -> TrendBrief:
    return TrendBrief(
        id=uuid4(),
        created_at=_NOW,
        updated_at=_NOW,
        status="processing",
        niche="manual",
        color_palette=palette,
        custom_flux_prompt=prompt,
        image_model=image_model,  # type: ignore[arg-type]
    )


async def test_gpt_image_custom_prompt_appends_palette_clause_when_set():
    brief = _brief_with_custom(
        _CUSTOM_GPT_PROMPT,
        palette=["#E8EEF2", "#D6C9C9", "#C7D3DD", "#77B6EA", "#37393A"],
        image_model="fal_gpt_image_2",
    )
    result = await build_gpt_image_prompt(brief)
    assert isinstance(result, ImagePrompt)
    # Operator's prompt survives verbatim at the front.
    assert result.prompt.startswith(_CUSTOM_GPT_PROMPT)
    # Palette is appended, hex codes are uppercase + no #.
    assert "Use only these colors: E8EEF2 D6C9C9 C7D3DD 77B6EA 37393A" in result.prompt
    # Color-restriction directive comes with the palette clause.
    assert "Every color in the image must come from this exact list" in result.prompt
    # The palette clause must NOT impose flat-fill or no-gradient rendering —
    # that is a style choice driven by the brief, not the palette.
    assert "flat, solid fill" not in result.prompt
    assert "no gradients" not in result.prompt


async def test_gpt_image_custom_prompt_skips_palette_when_already_inline():
    """Operator wrote the colors into the prompt themselves — don't double-list.
    Framing still auto-appends (separate concern), so just assert the auto
    palette clause is absent and the operator's text survives at the front.
    """
    custom_with_colors = _CUSTOM_GPT_PROMPT + " use these colors: E8EEF2 77B6EA 37393A"
    brief = _brief_with_custom(
        custom_with_colors,
        palette=["#E8EEF2", "#77B6EA", "#37393A"],
        image_model="fal_gpt_image_2",
    )
    result = await build_gpt_image_prompt(brief)
    assert result.prompt.startswith(custom_with_colors)
    # The auto palette clause must NOT have been appended on top.
    assert "Use only these colors:" not in result.prompt


async def test_gpt_image_custom_prompt_no_palette_keeps_operator_text_intact():
    """No palette → operator's prompt stays at the front (framing may append
    after it; that's exercised separately)."""
    brief = _brief_with_custom(
        _CUSTOM_GPT_PROMPT,
        palette=None,
        image_model="fal_gpt_image_2",
    )
    result = await build_gpt_image_prompt(brief)
    assert result.prompt.startswith(_CUSTOM_GPT_PROMPT)
    assert "Use only these colors:" not in result.prompt


async def test_flux_custom_prompt_appends_palette_clause_when_set():
    brief = _brief_with_custom(
        _CUSTOM_FLUX_PROMPT,
        palette=["#E8EEF2", "#D6C9C9", "#C7D3DD"],
        image_model="fal_flux_pro",
    )
    result = await build_flux_prompt(brief)
    assert isinstance(result, FluxPrompt)
    assert result.prompt.startswith(_CUSTOM_FLUX_PROMPT)
    assert "Use only these colors: E8EEF2 D6C9C9 C7D3DD" in result.prompt
    # Color list enforces WHICH colors appear; rendering style (flat / blended /
    # painted) is decided by the brief, not the palette clause.
    assert "flat, solid fill" not in result.prompt


async def test_flux_custom_prompt_skips_palette_when_already_inline():
    custom_with_colors = _CUSTOM_FLUX_PROMPT + " using colors #E8EEF2 #D6C9C9"
    brief = _brief_with_custom(
        custom_with_colors,
        palette=["#E8EEF2", "#D6C9C9"],
        image_model="fal_flux_pro",
    )
    result = await build_flux_prompt(brief)
    # Operator text + their inline palette survives at the front; auto-palette
    # clause is suppressed. Framing may auto-append after — separate concern.
    assert result.prompt.startswith(custom_with_colors)
    assert "Use only these colors:" not in result.prompt


async def test_palette_clause_ignores_malformed_entries():
    """Sparse / partially-invalid palettes still inject the valid entries.
    Defends against the dashboard's color picker returning whitespace or
    short-form ('#abc') strings that the validator strips earlier — we accept
    the survivors and skip the rest rather than aborting silently.
    """
    brief = _brief_with_custom(
        _CUSTOM_GPT_PROMPT,
        palette=["#E8EEF2", "not-a-hex", "", "77B6EA"],
        image_model="fal_gpt_image_2",
    )
    result = await build_gpt_image_prompt(brief)
    assert "Use only these colors: E8EEF2 77B6EA" in result.prompt


# --- Custom-prompt border-safe framing injection ----------------------------

# gpt-image-2 defaults to filling the canvas edge-to-edge. For print-on-demand
# we need a margin on all four sides so background removal produces a free-
# standing graphic, not a rectangular sticker. The custom-prompt path auto-
# appends a framing clause unless the operator already addressed it.


async def test_gpt_image_custom_prompt_appends_framing_clause():
    brief = _brief_with_custom(
        _CUSTOM_GPT_PROMPT,
        palette=None,
        image_model="fal_gpt_image_2",
    )
    result = await build_gpt_image_prompt(brief)
    lower = result.prompt.lower()
    assert "generous empty border" in lower
    assert "never touch the top, bottom, left, or right" in lower


async def test_gpt_image_custom_prompt_skips_framing_when_already_inline():
    """Operator already wrote the framing rule — don't double-append."""
    custom_with_framing = _CUSTOM_GPT_PROMPT + " Subject must not touch the edges of the image."
    brief = _brief_with_custom(
        custom_with_framing,
        palette=None,
        image_model="fal_gpt_image_2",
    )
    result = await build_gpt_image_prompt(brief)
    # The operator's phrase survives, but our literal opener "generous empty
    # border" is NOT also injected on top.
    assert "Subject must not touch the edges" in result.prompt
    assert "generous empty border" not in result.prompt.lower()


async def test_flux_custom_prompt_appends_framing_clause():
    brief = _brief_with_custom(
        _CUSTOM_FLUX_PROMPT,
        palette=None,
        image_model="fal_flux_pro",
    )
    result = await build_flux_prompt(brief)
    assert "generous empty border" in result.prompt.lower()


async def test_palette_and_framing_compose_in_order():
    """Both auto-append clauses run on the same custom prompt — palette first
    (it's about WHAT colors to paint), framing second (it's about WHERE the
    composition lives). Both must be present in the final prompt."""
    brief = _brief_with_custom(
        _CUSTOM_GPT_PROMPT,
        palette=["#E8EEF2", "#77B6EA"],
        image_model="fal_gpt_image_2",
    )
    result = await build_gpt_image_prompt(brief)
    # Palette clause present.
    assert "Use only these colors: E8EEF2 77B6EA" in result.prompt
    # Framing clause present.
    assert "generous empty border" in result.prompt.lower()
    # Palette clause comes before framing (read-order matters: paint THEN frame).
    palette_idx = result.prompt.find("Use only these colors")
    framing_idx = result.prompt.lower().find("generous empty border")
    assert palette_idx < framing_idx


# --- Regression: regen idempotency on edited custom prompts ----------------

# Bug: when the operator edited a regen prompt that already contained a
# "Use only these colors:" clause from a prior build, the palette dedup only
# checked for matching hex codes — a palette CHANGE produced two clauses in
# the same prompt. Same with the constraint suffix: no dedup at all, so the
# "Operator instruction (must follow):" line stacked on every regen.
# These tests pin the dedup to the literal sentinel phrases so re-builds are
# idempotent regardless of palette changes.


async def test_regen_with_old_palette_clause_does_not_double_when_palette_changes():
    """Operator's saved prompt has an OLD palette clause inline. brief
    .color_palette now contains a DIFFERENT set of hexes. Dedup must fire on
    the sentinel phrase so a second palette clause is not appended."""
    edited_with_old_clause = (
        "A bold screen print of a frog knight, flat-color rendering. "
        "Use only these colors: AAAAAA BBBBBB CCCCCC. "
        "Every color in the image must come from this exact list — no other colors permitted."
    )
    brief = _brief_with_custom(
        edited_with_old_clause,
        palette=["#111111", "#222222", "#333333"],  # NEW hexes, none in the text
        image_model="fal_gpt_image_2",
    )
    result = await build_gpt_image_prompt(brief)
    # Exactly ONE palette clause survives — the operator's old one. The new
    # palette field's hexes are NOT added on top.
    count = result.prompt.lower().count("use only these colors:")
    assert count == 1, f"expected exactly one palette clause, got {count}"
    assert "111111" not in result.prompt.upper()


async def test_regen_with_existing_constraint_clause_does_not_double():
    """Operator's saved prompt already contains an 'Operator instruction
    (must follow):' suffix from a prior regen. brief.prompt_constraint is set.
    The clause must NOT be appended again."""
    edited_with_existing_constraint = (
        "A bold screen print of a frog knight, flat-color rendering. "
        "Operator instruction (must follow): grumpy but cute, frog-shaped head."
    )
    brief = _brief_with_custom(
        edited_with_existing_constraint,
        palette=None,
        image_model="fal_gpt_image_2",
    )
    brief = brief.model_copy(update={"prompt_constraint": "grumpy but cute, frog-shaped head"})
    result = await build_gpt_image_prompt(brief)
    count = result.prompt.lower().count("operator instruction (must follow):")
    assert count == 1, f"expected exactly one constraint clause, got {count}"


async def test_regen_full_round_trip_is_idempotent():
    """Take a prompt the builder would output (palette + framing + constraint
    all auto-appended on a fresh build), feed it back in as custom_flux_prompt
    with the SAME palette and prompt_constraint, and the builder must NOT
    duplicate any clause. This is what happens when the operator clicks
    Regenerate without editing the prompt at all."""
    palette = ["#37393A", "#77B6EA", "#D4A96A"]
    constraint = "A bold screen print of a frog knight"
    initial = _brief_with_custom(
        "A frog knight in plate armor",
        palette=palette,
        image_model="fal_gpt_image_2",
    )
    initial = initial.model_copy(update={"prompt_constraint": constraint})
    first = await build_gpt_image_prompt(initial)

    # Now simulate the regen path: the brief's custom_flux_prompt becomes the
    # output of the previous build (which is what the dashboard's edit form
    # would round-trip).
    regen_brief = initial.model_copy(update={"custom_flux_prompt": first.prompt})
    second = await build_gpt_image_prompt(regen_brief)

    assert second.prompt.lower().count("use only these colors:") == 1
    assert second.prompt.lower().count("generous empty border") == 1
    assert second.prompt.lower().count("operator instruction (must follow):") == 1


async def test_legacy_ink_colors_clause_is_also_detected():
    """A custom prompt carrying the pre-refactor 'Use only these ink colors:'
    sentinel (older saved prompts in the wild) must also block re-append."""
    legacy = (
        "A bold screen print of a frog knight. "
        "Use only these ink colors: AABBCC. "
        "Render every shape as a flat, solid fill in one of these exact colors."
    )
    brief = _brief_with_custom(
        legacy,
        palette=["#111111"],
        image_model="fal_gpt_image_2",
    )
    result = await build_gpt_image_prompt(brief)
    # Neither marker re-appended.
    assert result.prompt.lower().count("use only these colors:") == 0
    assert result.prompt.lower().count("use only these ink colors:") == 1


# --- Brief-level prompt_constraint ------------------------------------------

# The Scout inject form writes `trend_briefs.prompt_constraint` — a free-text
# operator hint that must influence Claude when Design picks up the brief AND
# survive into custom-prompt regens. Distinct from custom_flux_prompt (which
# is a full override).


async def test_claude_path_receives_prompt_constraint_in_user_content(mocker):
    """Constraint flows into the user JSON sent to Claude so the prompt
    builder treats it as a high-priority directive."""
    brief = TrendBrief(
        id=uuid4(),
        created_at=_NOW,
        updated_at=_NOW,
        status="processing",
        niche="dark fantasy frog knight",
        prompt_constraint="lean hard into single-ink screen print, no shading",
    )
    client = _mock_client(mocker, json.dumps(_VALID_PROMPT))
    await build_flux_prompt(brief)
    user_content = client.messages.create.call_args.kwargs["messages"][0]["content"]
    assert "lean hard into single-ink screen print" in user_content
    # Field name is named so Claude can match the system-prompt section header.
    assert "prompt_constraint" in user_content


async def test_claude_system_prompt_documents_prompt_constraint(mocker):
    """The system prompt must reference the `prompt_constraint` field by name
    so Claude knows it's authoritative."""
    client = _mock_client(mocker, json.dumps(_VALID_PROMPT))
    await build_flux_prompt(_SAMPLE_BRIEF)
    system_text = client.messages.create.call_args.kwargs["system"][0]["text"]
    assert "prompt_constraint" in system_text


async def test_custom_prompt_appends_prompt_constraint_clause():
    """In the custom-prompt path (Scout inject + custom Design inject combined,
    or any regen of a brief that has both fields set), the constraint MUST
    survive to the final fal.ai prompt — not silently dropped."""
    brief = _brief_with_custom(
        _CUSTOM_GPT_PROMPT,
        palette=None,
        image_model="fal_gpt_image_2",
    )
    brief = brief.model_copy(
        update={"prompt_constraint": "make the head look grumpy but still cute"}
    )
    result = await build_gpt_image_prompt(brief)
    assert (
        "Operator instruction (must follow): make the head look grumpy but still cute"
        in result.prompt
    )


async def test_custom_prompt_empty_constraint_is_a_no_op():
    """Empty / whitespace-only constraint must NOT inject a hollow clause —
    otherwise every brief without a constraint would pick up a meaningless
    'Operator instruction:' suffix."""
    brief = _brief_with_custom(
        _CUSTOM_GPT_PROMPT,
        palette=None,
        image_model="fal_gpt_image_2",
    )
    brief = brief.model_copy(update={"prompt_constraint": "   "})
    result = await build_gpt_image_prompt(brief)
    assert "Operator instruction" not in result.prompt


# --- GPT_IMAGE_SYSTEM_PROMPT priority hierarchy -----------------------------

# When `prompt_constraint` is set, it must be the highest-authority signal.
# Design is content-neutral: style register comes from the brief
# (`style_keywords` / `prompt_constraint` / `custom_flux_prompt`), never from
# a baked-in house formula. The prompt enforces print-readiness and IP only.


async def test_gpt_image_system_prompt_states_constraint_is_highest_priority(mocker):
    """The priority-ordering language must be present in the system prompt so
    Claude knows operator constraint overrides any style guidance below."""
    from packages.design.prompt_builder import GPT_IMAGE_SYSTEM_PROMPT

    text = GPT_IMAGE_SYSTEM_PROMPT
    # Priority-ordering banner.
    assert "PRIORITY 1" in text
    assert "OPERATOR PROMPT CONSTRAINT" in text
    # Explicit hierarchy phrasing.
    assert "highest-priority" in text or "highest authority" in text.lower()
    # Conflict-resolution rule (rule, not just example).
    assert "DROP" in text
    assert "constraint wins" in text


async def test_gpt_image_system_prompt_includes_painting_recreation_example(mocker):
    """The painting-recreation worked example must be present so Claude has
    a concrete pattern for 'pick a specific famous painting' constraints —
    the exact failure mode that produced the boring generic cat output."""
    from packages.design.prompt_builder import GPT_IMAGE_SYSTEM_PROMPT

    text = GPT_IMAGE_SYSTEM_PROMPT
    # The example must name an actual painting so Claude learns to be specific.
    assert "Girl with a Pearl Earring" in text or "American Gothic" in text
    # The conflict-resolution case must be explicitly walked through.
    assert "Dealer's choice" in text or "BE specific" in text
    # The example must demonstrate painterly rendering for painting constraints.
    assert "chiaroscuro" in text.lower() or "preserve" in text.lower()


async def test_gpt_image_system_prompt_has_no_default_house_style(mocker):
    """Design is content-neutral. The system prompt MUST NOT bake in a default
    visual register (screen print, flat colors, character print study, etc.).
    Style direction comes from the brief's `style_keywords` /
    `prompt_constraint` — not from this prompt.

    Regression guard for the "boring cat painting" failure mode: Claude was
    stacking "dramatic shadows and highlights" (from the constraint) with
    "flat solid colors, no gradients, no shading" (from the baked house
    formula) in the same prompt. Removing the house formula removes that
    contradiction at the source.
    """
    from packages.design.prompt_builder import GPT_IMAGE_SYSTEM_PROMPT

    text = GPT_IMAGE_SYSTEM_PROMPT
    # PRIORITY 4 exists, but its job is to defer to the brief — not to impose
    # a screen-print default.
    assert "PRIORITY 4" in text
    assert "STYLE COMES FROM THE BRIEF" in text
    # Must NOT label a section as a "default house style" — that framing
    # contradicts content-neutrality.
    assert "DEFAULT HOUSE STYLE" not in text
    # Must explicitly disclaim a default rendering style.
    lower = text.lower()
    assert "no default rendering style" in lower or "no default house style" in lower
    # Must call out the historical baked openers/endings as forbidden defaults.
    assert "single centered screen print" in lower  # named as a thing NOT to default to
    # Must instruct Claude to read style from the brief.
    assert "style_keywords" in text
    assert "prompt_constraint" in text


async def test_palette_clause_does_not_impose_rendering_style():
    """The auto-appended palette clause must enforce WHICH colors appear, not
    HOW they're rendered. Forcing flat fills inside the palette clause was
    baking screen-print style into every palette-enabled brief — that style
    decision now lives in the brief's `style_keywords` instead.
    """
    from packages.design.prompt_builder import _palette_clause

    clause = _palette_clause(["#E8EEF2", "#77B6EA", "#37393A"])
    assert clause is not None
    # Color list is enforced.
    assert "Use only these colors: E8EEF2 77B6EA 37393A" in clause
    assert "no other colors permitted" in clause
    # Rendering style is NOT enforced.
    assert "flat" not in clause.lower()
    assert "gradient" not in clause.lower()
    assert "blend" not in clause.lower()
    assert "shading" not in clause.lower()
    assert "solid fill" not in clause.lower()


async def test_flux_system_prompt_palette_example_is_style_neutral():
    """The FLUX system prompt's palette-enforcement example must not bake a
    screen-print rendering directive into the canonical phrasing."""
    from packages.design.prompt_builder import SYSTEM_PROMPT

    text = SYSTEM_PROMPT
    # Old phrasing tied palette enforcement to "rendered as a screen print
    # using ONLY these ink colors" — that's gone.
    assert "rendered as a screen print" not in text.lower()
    assert "ink colors" not in text.lower()
    # New phrasing enforces colors only, not rendering style.
    assert "every color in the image must come from this exact list" in text.lower()


async def test_flux_system_prompt_declares_content_neutrality():
    """The FLUX system prompt must explicitly state that style direction comes
    from the brief's `style_keywords` / `prompt_constraint`, not from this
    agent. Prevents drift back toward baked screen-print defaults."""
    from packages.design.prompt_builder import SYSTEM_PROMPT

    # Collapse whitespace so multi-line phrasing still matches.
    text = SYSTEM_PROMPT
    flat = re.sub(r"\s+", " ", text).lower()
    # Must reference both signal channels.
    assert "style_keywords" in text
    assert "prompt_constraint" in text
    # Must explicitly disclaim a flat-color/screen-print/vector default —
    # phrased as either "do not impose a default" (header copy) or
    # "do not default to a flat-color/...screen-print look" (rule body).
    assert "do not impose a default" in flat or "do not default to" in flat

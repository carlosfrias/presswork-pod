from unittest.mock import AsyncMock, MagicMock

import pytest

from packages.design.constants import (
    GPT_IMAGE_DEFAULT_QUALITY,
    GPT_IMAGE_DIMENSIONS,
    GPT_IMAGE_MODEL,
)
from packages.design.gpt_image_client import generate_image_url
from packages.shared_py.models import ImagePrompt

_FAKE_IMAGE_URL = "https://cdn.fal.ai/images/gpt-image-2-test.png"

_PROMPT = ImagePrompt(
    prompt="A single centered illustration of a dark fantasy adventurer. Plain background.",
    style_descriptors=["dark", "fantasy", "illustration"],
)


@pytest.fixture(autouse=True)
def mock_settings(mocker):
    s = MagicMock()
    s.fal_key = "test-fal-key"
    from packages.shared_py.fal_http import fal_client_singleton

    fal_client_singleton.cache_clear()
    mocker.patch("packages.shared_py.fal_http.get_settings", return_value=s)


@pytest.fixture()
def mock_fal_run(mocker):
    result = {"images": [{"url": _FAKE_IMAGE_URL}]}
    run_mock = AsyncMock(return_value=result)
    client_instance = MagicMock()
    client_instance.run = run_mock
    mocker.patch(
        "packages.design.gpt_image_client.fal_client_singleton",
        return_value=client_instance,
    )
    return run_mock


async def test_happy_path_returns_fal_image_url(mock_fal_run):
    url = await generate_image_url(_PROMPT)
    assert url == _FAKE_IMAGE_URL


async def test_fal_run_called_with_correct_args(mock_fal_run):
    await generate_image_url(_PROMPT, quality="high")
    mock_fal_run.assert_called_once()
    args_positional = mock_fal_run.call_args.args
    assert args_positional[0] == GPT_IMAGE_MODEL
    call_args = mock_fal_run.call_args.kwargs.get("arguments") or args_positional[1]
    assert call_args["prompt"] == _PROMPT.prompt
    assert call_args["image_size"] == GPT_IMAGE_DIMENSIONS
    assert call_args["quality"] == "high"
    assert call_args["num_images"] == 1
    assert call_args["output_format"] == "png"
    # gpt-image-2's schema has no negative_prompt field — never pass one.
    assert "negative_prompt" not in call_args


async def test_quality_defaults_to_module_default_when_none(mock_fal_run):
    """Brief-level image_quality NULL means 'use the default tier'. The client
    must not forward a literal None into fal — that would be a 4xx."""
    await generate_image_url(_PROMPT, quality=None)
    call_args = mock_fal_run.call_args.kwargs["arguments"]
    assert call_args["quality"] == GPT_IMAGE_DEFAULT_QUALITY


async def test_records_usage_with_gpt_image_2_operation(mock_fal_run, mocker):
    record_mock = mocker.patch("packages.design.gpt_image_client.record_usage")
    await generate_image_url(_PROMPT, quality="medium")
    record_mock.assert_called_once()
    kwargs = record_mock.call_args.kwargs
    assert kwargs["agent"] == "design"
    assert kwargs["provider"] == "fal"
    assert kwargs["operation"] == "gpt_image_2"
    assert kwargs["cost_usd"] is not None and kwargs["cost_usd"] > 0
    assert kwargs["metadata"]["model"] == GPT_IMAGE_MODEL
    assert kwargs["metadata"]["quality"] == "medium"

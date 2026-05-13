from unittest.mock import AsyncMock, MagicMock

import pytest

from packages.design.constants import FLUX_IMAGE_DIMENSIONS, FLUX_MODEL
from packages.design.fal_client import generate_image_url
from packages.shared_py.models import FluxPrompt

_FAKE_IMAGE_URL = "https://cdn.fal.ai/images/test.png"

_PROMPT = FluxPrompt(
    prompt="print on demand design, vector-style mountain, white background",
    negative_prompt="blurry, low quality",
    style_descriptors=["minimalist"],
)


@pytest.fixture(autouse=True)
def mock_settings(mocker):
    s = MagicMock()
    s.fal_key = "test-fal-key"
    # fal_client_singleton is lru_cached, so clear it before patching settings
    # to avoid leaked clients from other tests' settings stubs.
    from packages.shared_py.fal_http import fal_client_singleton

    fal_client_singleton.cache_clear()
    mocker.patch("packages.shared_py.fal_http.get_settings", return_value=s)


@pytest.fixture()
def mock_fal_run(mocker):
    """Patch the shared fal_client_singleton's run() method. No upload mock,
    no respx — generate_image_url no longer downloads bytes."""
    result = {"images": [{"url": _FAKE_IMAGE_URL}]}
    run_mock = AsyncMock(return_value=result)
    client_instance = MagicMock()
    client_instance.run = run_mock
    # Patch at the import site (packages.design.fal_client) — the
    # `fal_client_singleton` symbol was imported into that module's namespace,
    # so patching it on packages.shared_py.fal_http alone wouldn't intercept.
    mocker.patch(
        "packages.design.fal_client.fal_client_singleton",
        return_value=client_instance,
    )
    return run_mock


async def test_happy_path_returns_fal_image_url(mock_fal_run):
    url = await generate_image_url(_PROMPT)
    assert url == _FAKE_IMAGE_URL


async def test_fal_run_called_with_correct_args(mock_fal_run):
    await generate_image_url(_PROMPT)
    mock_fal_run.assert_called_once()
    args_positional = mock_fal_run.call_args.args
    assert args_positional[0] == FLUX_MODEL
    call_args = mock_fal_run.call_args.kwargs.get("arguments") or args_positional[1]
    assert call_args["output_format"] == "png"
    assert call_args["safety_tolerance"] == "2"
    assert call_args["num_images"] == 1
    # New: near-5:6 portrait dict instead of "square_hd" enum (FLUX snaps to 32-multiples)
    assert call_args["image_size"] == FLUX_IMAGE_DIMENSIONS


async def test_supports_singular_image_response_shape(mocker):
    """Some fal models return `{"image": {"url": ...}}` instead of plural
    `{"images": [...]}`. extract_output_url handles both — regression guard
    so a fal-side shape tweak doesn't break FLUX."""
    from packages.shared_py.fal_http import fal_client_singleton

    fal_client_singleton.cache_clear()
    s = MagicMock()
    s.fal_key = "test-fal-key"
    mocker.patch("packages.shared_py.fal_http.get_settings", return_value=s)

    result = {"image": {"url": _FAKE_IMAGE_URL}}
    run_mock = AsyncMock(return_value=result)
    client_instance = MagicMock()
    client_instance.run = run_mock
    # Patch at the import site (packages.design.fal_client) — the
    # `fal_client_singleton` symbol was imported into that module's namespace,
    # so patching it on packages.shared_py.fal_http alone wouldn't intercept.
    mocker.patch(
        "packages.design.fal_client.fal_client_singleton",
        return_value=client_instance,
    )

    url = await generate_image_url(_PROMPT)
    assert url == _FAKE_IMAGE_URL

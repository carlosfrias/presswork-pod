from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
import respx

from packages.design.constants import FLUX_IMAGE_SIZE, FLUX_MODEL
from packages.design.fal_client import generate_image
from packages.shared_py.models import FluxPrompt

_FAKE_IMAGE_URL = "https://cdn.fal.ai/images/test.png"
_FAKE_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100

_PROMPT = FluxPrompt(
    prompt="print on demand design, transparent background, high resolution, vector-style mountain",
    negative_prompt="blurry, low quality",
    style_descriptors=["minimalist"],
)


@pytest.fixture(autouse=True)
def mock_settings(mocker):
    s = MagicMock()
    s.fal_key = "test-fal-key"
    mocker.patch("packages.design.fal_client.get_settings", return_value=s)


@pytest.fixture()
def mock_fal_run(mocker):
    result = {"images": [{"url": _FAKE_IMAGE_URL}]}
    run_mock = AsyncMock(return_value=result)
    client_instance = MagicMock()
    client_instance.run = run_mock
    # Capture the AsyncClient constructor so tests can assert key= was passed.
    ctor = MagicMock(return_value=client_instance)
    mocker.patch("packages.design.fal_client.fal_client.AsyncClient", ctor)
    # Expose both for assertions
    run_mock._ctor = ctor
    return run_mock


@respx.mock
async def test_happy_path_returns_png_bytes(mock_fal_run):
    respx.get(_FAKE_IMAGE_URL).mock(return_value=httpx.Response(200, content=_FAKE_PNG))
    result = await generate_image(_PROMPT)
    assert result == _FAKE_PNG


@respx.mock
async def test_5xx_on_image_download_retried_then_raises(mock_fal_run):
    respx.get(_FAKE_IMAGE_URL).mock(return_value=httpx.Response(503))
    with pytest.raises(httpx.HTTPStatusError):
        await generate_image(_PROMPT)
    assert respx.calls.call_count == 3


@respx.mock
async def test_fal_run_called_with_correct_args(mock_fal_run):
    respx.get(_FAKE_IMAGE_URL).mock(return_value=httpx.Response(200, content=_FAKE_PNG))
    await generate_image(_PROMPT)
    mock_fal_run.assert_called_once()
    args_positional = mock_fal_run.call_args.args
    call_model = args_positional[0]
    assert call_model == FLUX_MODEL
    call_args = mock_fal_run.call_args.kwargs.get("arguments") or args_positional[1]
    assert call_args["output_format"] == "png"
    assert call_args["safety_tolerance"] == "2"
    assert call_args["num_images"] == 1
    assert call_args["image_size"] == FLUX_IMAGE_SIZE


@respx.mock
async def test_fal_key_passed_to_client_no_environ_mutation(mock_fal_run, monkeypatch):
    """Bug #24: FAL_KEY threaded explicitly; os.environ['FAL_KEY'] never set."""
    import os

    monkeypatch.delenv("FAL_KEY", raising=False)

    respx.get(_FAKE_IMAGE_URL).mock(return_value=httpx.Response(200, content=_FAKE_PNG))
    await generate_image(_PROMPT)

    # AsyncClient(key=...) called exactly once with the settings.fal_key value
    mock_fal_run._ctor.assert_called_once_with(key="test-fal-key")
    # And no global state mutation
    assert os.environ.get("FAL_KEY") is None

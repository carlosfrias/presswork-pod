from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
import respx

from packages.design.constants import UPSCALER_MODEL, UPSCALER_SCALE
from packages.design.upscaler import upscale_image

_FAKE_INPUT_URL = "https://fal.media/files/upload/input.png"
_FAKE_UPSCALED_URL = "https://cdn.fal.ai/aura-sr/upscaled.png"
_INPUT_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
_UPSCALED_PNG = b"\x89PNG\r\n\x1a\n" + b"\xff" * 400


@pytest.fixture(autouse=True)
def mock_settings(mocker):
    s = MagicMock()
    s.fal_key = "test-fal-key"
    mocker.patch("packages.design.upscaler.get_settings", return_value=s)


@pytest.fixture()
def mock_fal_run(mocker):
    """Mocks both upload() and run() on the AsyncClient. upload() returns the
    temporary fal storage URL; run() returns the aura-sr result envelope."""
    result = {"image": {"url": _FAKE_UPSCALED_URL}}
    run_mock = AsyncMock(return_value=result)
    upload_mock = AsyncMock(return_value=_FAKE_INPUT_URL)
    client_instance = MagicMock()
    client_instance.run = run_mock
    client_instance.upload = upload_mock
    ctor = MagicMock(return_value=client_instance)
    mocker.patch("packages.design.upscaler.fal_client.AsyncClient", ctor)
    run_mock._ctor = ctor
    run_mock._upload = upload_mock
    return run_mock


@respx.mock
async def test_happy_path_returns_upscaled_png_bytes(mock_fal_run):
    respx.get(_FAKE_UPSCALED_URL).mock(return_value=httpx.Response(200, content=_UPSCALED_PNG))
    result = await upscale_image(_INPUT_PNG)
    assert result == _UPSCALED_PNG


@respx.mock
async def test_passes_correct_model_and_scale_args(mock_fal_run):
    respx.get(_FAKE_UPSCALED_URL).mock(return_value=httpx.Response(200, content=_UPSCALED_PNG))
    await upscale_image(_INPUT_PNG)

    mock_fal_run.assert_called_once()
    args_positional = mock_fal_run.call_args.args
    assert args_positional[0] == UPSCALER_MODEL
    call_args = mock_fal_run.call_args.kwargs.get("arguments") or args_positional[1]
    assert call_args["image_url"] == _FAKE_INPUT_URL
    assert call_args["upscaling_factor"] == UPSCALER_SCALE


@respx.mock
async def test_upload_called_with_png_bytes(mock_fal_run):
    respx.get(_FAKE_UPSCALED_URL).mock(return_value=httpx.Response(200, content=_UPSCALED_PNG))
    await upscale_image(_INPUT_PNG)

    mock_fal_run._upload.assert_called_once()
    upload_args = mock_fal_run._upload.call_args.args
    assert upload_args[0] == _INPUT_PNG
    assert upload_args[1] == "image/png"


@respx.mock
async def test_5xx_on_download_retried_three_times(mock_fal_run):
    respx.get(_FAKE_UPSCALED_URL).mock(return_value=httpx.Response(503))
    with pytest.raises(httpx.HTTPStatusError):
        await upscale_image(_INPUT_PNG)
    assert respx.calls.call_count == 3


@respx.mock
async def test_4xx_on_download_raises_immediately(mock_fal_run):
    respx.get(_FAKE_UPSCALED_URL).mock(return_value=httpx.Response(400))
    with pytest.raises(httpx.HTTPStatusError):
        await upscale_image(_INPUT_PNG)
    # 4xx is not retryable per _is_retryable — exactly one call expected.
    assert respx.calls.call_count == 1


@respx.mock
async def test_fal_key_passed_to_client_no_environ_mutation(mock_fal_run, monkeypatch):
    """Same guarantee as fal_client.py: FAL_KEY threaded explicitly, never via os.environ."""
    import os

    monkeypatch.delenv("FAL_KEY", raising=False)

    respx.get(_FAKE_UPSCALED_URL).mock(return_value=httpx.Response(200, content=_UPSCALED_PNG))
    await upscale_image(_INPUT_PNG)

    mock_fal_run._ctor.assert_called_once_with(key="test-fal-key")
    assert os.environ.get("FAL_KEY") is None

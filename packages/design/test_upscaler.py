from unittest.mock import AsyncMock, MagicMock

import pytest

from packages.design.constants import UPSCALER_MODEL, UPSCALER_SCALE
from packages.design.upscaler import upscale_url

_FAKE_INPUT_URL = "https://fal.media/files/upload/input.png"
_FAKE_UPSCALED_URL = "https://cdn.fal.ai/aura-sr/upscaled.png"


@pytest.fixture(autouse=True)
def mock_settings(mocker):
    s = MagicMock()
    s.fal_key = "test-fal-key"
    from packages.shared_py.fal_http import fal_client_singleton

    fal_client_singleton.cache_clear()
    mocker.patch("packages.shared_py.fal_http.get_settings", return_value=s)


@pytest.fixture()
def mock_fal_run(mocker):
    """Patch the shared fal singleton's run() method. No upload mock — the
    URL-threaded path never uploads bytes; it passes the input URL straight
    through to aura-sr."""
    result = {"image": {"url": _FAKE_UPSCALED_URL}}
    run_mock = AsyncMock(return_value=result)
    client_instance = MagicMock()
    client_instance.run = run_mock
    # Patch at the import site (packages.design.upscaler) — same as test_fal_client.
    mocker.patch(
        "packages.design.upscaler.fal_client_singleton",
        return_value=client_instance,
    )
    return run_mock


async def test_happy_path_returns_upscaled_url(mock_fal_run):
    url = await upscale_url(_FAKE_INPUT_URL)
    assert url == _FAKE_UPSCALED_URL


async def test_passes_input_url_and_scale_args(mock_fal_run):
    await upscale_url(_FAKE_INPUT_URL)

    mock_fal_run.assert_called_once()
    args_positional = mock_fal_run.call_args.args
    assert args_positional[0] == UPSCALER_MODEL
    call_args = mock_fal_run.call_args.kwargs.get("arguments") or args_positional[1]
    assert call_args["image_url"] == _FAKE_INPUT_URL
    assert call_args["upscaling_factor"] == UPSCALER_SCALE
    assert call_args["overlapping_tiles"] is True


async def test_no_upload_called(mock_fal_run, mocker):
    """Regression guard for the efficiency refactor: upscale_url MUST NOT
    call client.upload(). The whole point of the URL refactor is that we
    pass URLs through, not bytes."""
    # The shared singleton mock from mock_fal_run doesn't expose an upload
    # attribute by default — accessing it would create an autospeccable
    # MagicMock. Assert we never touched it.
    client = mocker.patch("packages.design.upscaler.fal_client_singleton").return_value
    client.run = mock_fal_run

    await upscale_url(_FAKE_INPUT_URL)
    # If upload had been called, the spec would have a recorded call.
    upload_calls = getattr(client.upload, "call_args_list", [])
    assert upload_calls == []

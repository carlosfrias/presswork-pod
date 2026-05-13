from unittest.mock import AsyncMock, MagicMock

import pytest

from packages.design.birefnet import remove_background_birefnet_url
from packages.design.constants import BIREFNET_MODEL

_FAKE_INPUT_URL = "https://fal.media/files/upload/input.png"
_FAKE_OUTPUT_URL = "https://cdn.fal.ai/birefnet/transparent.png"


@pytest.fixture(autouse=True)
def mock_settings(mocker):
    s = MagicMock()
    s.fal_key = "test-fal-key"
    from packages.shared_py.fal_http import fal_client_singleton

    fal_client_singleton.cache_clear()
    mocker.patch("packages.shared_py.fal_http.get_settings", return_value=s)


def _patch_fal_singleton(mocker, result: dict) -> AsyncMock:
    run_mock = AsyncMock(return_value=result)
    client_instance = MagicMock()
    client_instance.run = run_mock
    # Patch at the import site (packages.design.birefnet).
    mocker.patch(
        "packages.design.birefnet.fal_client_singleton",
        return_value=client_instance,
    )
    return run_mock


@pytest.fixture()
def mock_fal_run(mocker):
    return _patch_fal_singleton(mocker, {"image": {"url": _FAKE_OUTPUT_URL}})


async def test_happy_path_returns_transparent_png_url(mock_fal_run):
    url = await remove_background_birefnet_url(_FAKE_INPUT_URL)
    assert url == _FAKE_OUTPUT_URL


async def test_passes_correct_model_and_image_url(mock_fal_run):
    await remove_background_birefnet_url(_FAKE_INPUT_URL)

    mock_fal_run.assert_called_once()
    args_positional = mock_fal_run.call_args.args
    assert args_positional[0] == BIREFNET_MODEL
    call_args = mock_fal_run.call_args.kwargs.get("arguments") or args_positional[1]
    assert call_args["image_url"] == _FAKE_INPUT_URL
    # Do NOT pass background_color — output must remain transparent.
    assert "background_color" not in call_args


async def test_supports_plural_images_response_shape(mocker):
    """Defensive: if fal ever flips birefnet's response shape to plural,
    extract_output_url still finds the URL."""
    run_mock = _patch_fal_singleton(mocker, {"images": [{"url": _FAKE_OUTPUT_URL}]})

    url = await remove_background_birefnet_url(_FAKE_INPUT_URL)
    assert url == _FAKE_OUTPUT_URL
    run_mock.assert_called_once()


async def test_no_upload_called(mocker):
    """Regression guard for the efficiency refactor: the URL path must not
    upload bytes. Birefnet receives the input URL straight through."""
    run_mock = _patch_fal_singleton(mocker, {"image": {"url": _FAKE_OUTPUT_URL}})
    client = mocker.patch("packages.design.birefnet.fal_client_singleton").return_value
    client.run = run_mock

    await remove_background_birefnet_url(_FAKE_INPUT_URL)
    upload_calls = getattr(client.upload, "call_args_list", [])
    assert upload_calls == []

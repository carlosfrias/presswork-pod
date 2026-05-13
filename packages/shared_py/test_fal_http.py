import asyncio
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
import respx

from packages.shared_py.fal_http import (
    FalTimeoutError,
    download_image,
    extract_output_url,
    is_retryable,
    run_with_timeout,
)

_FAKE_URL = "https://cdn.fal.ai/test/image.png"
_FAKE_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100


# --- download_image retry semantics ---------------------------------------


@respx.mock
async def test_download_image_happy_path():
    respx.get(_FAKE_URL).mock(return_value=httpx.Response(200, content=_FAKE_PNG))
    assert await download_image(_FAKE_URL) == _FAKE_PNG


@respx.mock
async def test_download_image_5xx_retried_three_times():
    respx.get(_FAKE_URL).mock(return_value=httpx.Response(503))
    with pytest.raises(httpx.HTTPStatusError):
        await download_image(_FAKE_URL)
    # 3 attempts: original + 2 retries. tenacity stop_after_attempt(3) caps total.
    assert respx.calls.call_count == 3


@respx.mock
async def test_download_image_4xx_raises_immediately():
    respx.get(_FAKE_URL).mock(return_value=httpx.Response(400))
    with pytest.raises(httpx.HTTPStatusError):
        await download_image(_FAKE_URL)
    # 4xx is not retryable per is_retryable — exactly one call expected.
    assert respx.calls.call_count == 1


# --- is_retryable classification ------------------------------------------


def _http_error(status_code: int) -> httpx.HTTPStatusError:
    req = httpx.Request("GET", _FAKE_URL)
    resp = httpx.Response(status_code, request=req)
    return httpx.HTTPStatusError("boom", request=req, response=resp)


def test_is_retryable_5xx_true():
    assert is_retryable(_http_error(500)) is True
    assert is_retryable(_http_error(503)) is True


def test_is_retryable_4xx_false():
    assert is_retryable(_http_error(400)) is False
    assert is_retryable(_http_error(429)) is False


def test_is_retryable_network_errors_true():
    assert is_retryable(httpx.ConnectError("dns")) is True
    assert is_retryable(httpx.ReadError("reset")) is True
    assert is_retryable(httpx.TimeoutException("slow")) is True


def test_is_retryable_other_errors_false():
    assert is_retryable(ValueError("bad input")) is False
    assert is_retryable(RuntimeError("oops")) is False


# --- extract_output_url defensive shape handling --------------------------


def test_extract_output_url_singular_image_shape():
    assert extract_output_url({"image": {"url": "https://x/y.png"}}) == "https://x/y.png"


def test_extract_output_url_plural_images_shape():
    payload = {"images": [{"url": "https://x/y.png"}]}
    assert extract_output_url(payload) == "https://x/y.png"


def test_extract_output_url_missing_raises():
    with pytest.raises(ValueError, match="missing image url"):
        extract_output_url({"status": "ok"})


def test_extract_output_url_malformed_image_shape_raises():
    with pytest.raises(ValueError):
        extract_output_url({"image": "not-a-dict"})


def test_extract_output_url_empty_images_array_raises():
    with pytest.raises(ValueError):
        extract_output_url({"images": []})


# --- run_with_timeout: prevents the hang we just hit ----------------------


async def test_run_with_timeout_returns_result_on_success():
    expected = {"images": [{"url": "https://cdn.fal.ai/x.png"}]}
    client = MagicMock()
    client.run = AsyncMock(return_value=expected)

    result = await run_with_timeout(client, "fal-ai/example", arguments={"k": "v"}, timeout_s=1.0)

    assert result == expected
    client.run.assert_called_once_with("fal-ai/example", arguments={"k": "v"})


async def test_run_with_timeout_raises_fal_timeout_error_when_slow():
    """The regression we're guarding against: fal.ai's client.run polled
    indefinitely on a rejected gpt-image-2 request, hanging our agent and
    leaving the brief stuck at status='processing'. wait_for must convert
    that into a FalTimeoutError so main.py's catch path can mark error."""

    async def never_returns(*_args, **_kwargs):
        await asyncio.sleep(10)
        return {}

    client = MagicMock()
    client.run = never_returns

    with pytest.raises(FalTimeoutError, match="exceeded"):
        await run_with_timeout(client, "fal-ai/example", arguments={}, timeout_s=0.05)


async def test_run_with_timeout_propagates_non_timeout_exceptions():
    """A fal-side 4xx must still surface as the underlying exception, not be
    swallowed by the timeout wrapper."""
    client = MagicMock()
    client.run = AsyncMock(side_effect=RuntimeError("422 image too big"))

    with pytest.raises(RuntimeError, match="422"):
        await run_with_timeout(client, "fal-ai/example", arguments={}, timeout_s=1.0)

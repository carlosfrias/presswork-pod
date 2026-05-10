import asyncio
from unittest.mock import MagicMock

import httpx
import pytest
import respx

from packages.scout.etsy_client import EtsyClient

pytestmark = pytest.mark.asyncio

_LISTINGS_URL = "https://api.etsy.com/v3/application/listings/active"
_TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token"
_FAKE_LISTINGS = [{"listing_id": 1, "title": "Funny Dog Mom Shirt"}]


@pytest.fixture(autouse=True)
def mock_settings(mocker):
    s = MagicMock()
    s.etsy_access_token = "test-token"
    s.etsy_refresh_token = "test-refresh"
    s.etsy_api_key = "test-api-key"
    mocker.patch("packages.scout.etsy_client.get_settings", return_value=s)
    return s


@respx.mock
async def test_happy_path():
    respx.get(_LISTINGS_URL).mock(
        return_value=httpx.Response(200, json={"results": _FAKE_LISTINGS})
    )
    client = EtsyClient()
    result = await client.fetch_top_listings("dog mom")
    assert result == _FAKE_LISTINGS


@respx.mock
async def test_rate_limit_max_5_concurrent():
    """10 simultaneous calls must never exceed 5 in-flight at once."""
    peak = 0
    current = 0
    lock = asyncio.Lock()

    async def counting_handler(request: httpx.Request) -> httpx.Response:
        nonlocal peak, current
        async with lock:
            current += 1
            if current > peak:
                peak = current
        await asyncio.sleep(0.05)
        async with lock:
            current -= 1
        return httpx.Response(200, json={"results": []})

    respx.get(_LISTINGS_URL).mock(side_effect=counting_handler)
    client = EtsyClient()
    await asyncio.gather(*[client.fetch_top_listings(f"niche-{i}") for i in range(10)])
    assert peak <= 5


@respx.mock
async def test_401_refresh_retry_succeeds():
    """On 401, client refreshes token and retries; second call succeeds."""
    respx.post(_TOKEN_URL).mock(
        return_value=httpx.Response(200, json={"access_token": "new-token"})
    )
    respx.get(_LISTINGS_URL).mock(
        side_effect=[
            httpx.Response(401),
            httpx.Response(200, json={"results": _FAKE_LISTINGS}),
        ]
    )
    client = EtsyClient()
    result = await client.fetch_top_listings("dog mom")
    assert result == _FAKE_LISTINGS
    assert client._access_token == "new-token"


@respx.mock
async def test_401_refresh_still_401_raises():
    """On 401 → refresh → 401, raises HTTPStatusError without further retries."""
    respx.post(_TOKEN_URL).mock(
        return_value=httpx.Response(200, json={"access_token": "new-token"})
    )
    respx.get(_LISTINGS_URL).mock(return_value=httpx.Response(401))
    client = EtsyClient()
    with pytest.raises(httpx.HTTPStatusError) as exc_info:
        await client.fetch_top_listings("dog mom")
    assert exc_info.value.response.status_code == 401

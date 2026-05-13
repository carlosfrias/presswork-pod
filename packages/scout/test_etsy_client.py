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
    # Also patch get_settings inside the tokens module where load_tokens reads it.
    mocker.patch("packages.shared_py.etsy_tokens.get_settings", return_value=s)
    return s


@pytest.fixture(autouse=True)
def mock_db(mocker):
    """EtsyClient now loads/saves tokens via supabase. Empty config table →
    EtsyClient falls back to env-seeded tokens (already-expired sentinel)."""
    db = MagicMock()
    # config.select(...).eq(...).execute() returns no rows
    db.table.return_value.select.return_value.eq.return_value.execute.return_value.data = []
    # upsert(...).execute() is fire-and-forget
    db.table.return_value.upsert.return_value.execute.return_value = MagicMock()
    mocker.patch("packages.scout.etsy_client.get_db", return_value=db)
    return db


@respx.mock
async def test_happy_path():
    respx.get(_LISTINGS_URL).mock(
        return_value=httpx.Response(200, json={"results": _FAKE_LISTINGS})
    )
    client = EtsyClient()
    result = await client.fetch_top_listings("dog mom")
    assert result == _FAKE_LISTINGS


@respx.mock
async def test_rate_limited_to_10_per_second():
    """Bug #19: limiter must cap rate (not just concurrency). 20 calls at
    10 req/s should take at least ~1 second total wall-clock."""
    import time

    respx.get(_LISTINGS_URL).mock(return_value=httpx.Response(200, json={"results": []}))
    client = EtsyClient()
    t0 = time.monotonic()
    await asyncio.gather(*[client.fetch_top_listings(f"niche-{i}") for i in range(20)])
    elapsed = time.monotonic() - t0
    # 20 calls / 10 rps → at least ~1.0s. Give some slack for scheduling jitter.
    assert elapsed >= 0.9, f"Expected ≥0.9s for 20 calls at 10 rps, got {elapsed:.2f}s"


@respx.mock
async def test_401_refresh_retry_succeeds():
    """On 401, client refreshes token and retries; second call succeeds."""
    respx.post(_TOKEN_URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "access_token": "new-token",
                "refresh_token": "rotated-refresh",
                "expires_in": 3600,
            },
        )
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
    assert client._tokens.access_token == "new-token"
    # Etsy rotates refresh_token on use — must be captured + persisted.
    assert client._tokens.refresh_token == "rotated-refresh"


@respx.mock
async def test_401_refresh_still_401_raises():
    """On 401 → refresh → 401, raises HTTPStatusError without further retries."""
    respx.post(_TOKEN_URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "access_token": "new-token",
                "refresh_token": "rotated-refresh",
                "expires_in": 3600,
            },
        )
    )
    respx.get(_LISTINGS_URL).mock(return_value=httpx.Response(401))
    client = EtsyClient()
    with pytest.raises(httpx.HTTPStatusError) as exc_info:
        await client.fetch_top_listings("dog mom")
    assert exc_info.value.response.status_code == 401


@respx.mock
async def test_fetch_top_listings_includes_images_when_requested():
    route = respx.get(_LISTINGS_URL).mock(
        return_value=httpx.Response(200, json={"results": _FAKE_LISTINGS})
    )
    client = EtsyClient()
    await client.fetch_top_listings("dog mom", include_images=True)
    assert route.call_count == 1
    request = route.calls.last.request
    assert request.url.params.get("includes") == "Images"


@respx.mock
async def test_fetch_top_listings_omits_includes_by_default():
    route = respx.get(_LISTINGS_URL).mock(
        return_value=httpx.Response(200, json={"results": _FAKE_LISTINGS})
    )
    client = EtsyClient()
    await client.fetch_top_listings("dog mom")
    assert route.call_count == 1
    request = route.calls.last.request
    assert "includes" not in request.url.params


@respx.mock
async def test_refresh_persists_rotated_refresh_token_to_supabase(mock_db):
    """Bug #11: Etsy rotates refresh_token on each refresh; must persist it."""
    respx.post(_TOKEN_URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "access_token": "new-token",
                "refresh_token": "rotated-refresh",
                "expires_in": 3600,
            },
        )
    )
    respx.get(_LISTINGS_URL).mock(
        side_effect=[
            httpx.Response(401),
            httpx.Response(200, json={"results": _FAKE_LISTINGS}),
        ]
    )
    client = EtsyClient()
    await client.fetch_top_listings("dog mom")

    upsert_calls = mock_db.table.return_value.upsert.call_args_list
    # At least one upsert should write the new tokens
    persisted = [c.args[0] for c in upsert_calls if c.args and c.args[0].get("key") == "etsy_oauth"]
    assert len(persisted) >= 1
    assert persisted[-1]["value"]["refresh_token"] == "rotated-refresh"
    assert persisted[-1]["value"]["access_token"] == "new-token"

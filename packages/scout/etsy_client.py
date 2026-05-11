import asyncio
from datetime import UTC, datetime
from typing import Any

import httpx
from aiolimiter import AsyncLimiter
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_exponential

from packages.shared_py.config import get_settings
from packages.shared_py.db import get_db
from packages.shared_py.etsy_tokens import (
    EtsyTokens,
    get_refresh_lock,
    load_tokens,
    save_tokens,
    tokens_from_response,
)

_LISTINGS_URL = "https://api.etsy.com/v3/application/listings/active"
_TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token"


def _is_server_error(exc: BaseException) -> bool:
    return isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code >= 500


class EtsyClient:
    def __init__(self) -> None:
        settings = get_settings()
        self._db = get_db()
        self._tokens: EtsyTokens = load_tokens(self._db)
        self._api_key: str = settings.etsy_api_key
        # Etsy's documented limit is 10 req/sec. AsyncLimiter caps actual rate
        # (not concurrency) — the previous Semaphore(5) only limited in-flight
        # requests, allowing bursts well above the API ceiling.
        self._limiter = AsyncLimiter(10, 1)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._tokens.access_token}"}

    async def _refresh(self) -> None:
        # Coalesce concurrent refreshes — only one in-flight POST per process.
        # After acquiring the lock, re-read tokens in case another coroutine
        # already refreshed while we were waiting.
        async with get_refresh_lock():
            fresh = await asyncio.to_thread(load_tokens, self._db)
            if (
                fresh.expires_at > datetime.now(tz=UTC)
                and fresh.access_token != self._tokens.access_token
            ):
                self._tokens = fresh
                return

            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    _TOKEN_URL,
                    data={
                        "grant_type": "refresh_token",
                        "client_id": self._api_key,
                        # Etsy rotates refresh_token on use — capture the new one
                        # from the response (tokens_from_response below) and
                        # persist it so the next refresh works.
                        "refresh_token": self._tokens.refresh_token,
                    },
                )
                resp.raise_for_status()
                new_tokens = tokens_from_response(resp.json())
                await asyncio.to_thread(save_tokens, self._db, new_tokens)
                self._tokens = new_tokens

    async def _get(
        self,
        client: httpx.AsyncClient,
        url: str,
        params: dict[str, Any],
    ) -> httpx.Response:
        async with self._limiter:
            return await client.get(url, params=params, headers=self._headers())

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=10),
        retry=retry_if_exception(_is_server_error),
        reraise=True,
    )
    async def _fetch_with_retry(
        self,
        client: httpx.AsyncClient,
        params: dict[str, Any],
    ) -> httpx.Response:
        resp = await self._get(client, _LISTINGS_URL, params)
        if resp.status_code >= 500:
            resp.raise_for_status()
        return resp

    async def fetch_top_listings(self, niche: str, limit: int = 25) -> list[dict]:
        params: dict[str, Any] = {
            "keywords": niche,
            "sort_on": "score",
            "limit": limit,
        }
        async with httpx.AsyncClient() as client:
            resp = await self._fetch_with_retry(client, params)
            if resp.status_code == 401:
                await self._refresh()
                resp = await self._get(client, _LISTINGS_URL, params)
                if resp.status_code == 401:
                    resp.raise_for_status()
            resp.raise_for_status()
            return resp.json().get("results", [])

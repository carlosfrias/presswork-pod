import asyncio
from typing import Any

import httpx
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_exponential

from packages.shared_py.config import get_settings

_LISTINGS_URL = "https://api.etsy.com/v3/application/listings/active"
_TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token"


def _is_server_error(exc: BaseException) -> bool:
    return isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code >= 500


class EtsyClient:
    def __init__(self) -> None:
        settings = get_settings()
        self._access_token: str = settings.etsy_access_token
        self._refresh_token_val: str = settings.etsy_refresh_token
        self._api_key: str = settings.etsy_api_key
        self._semaphore = asyncio.Semaphore(5)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._access_token}"}

    async def _refresh(self) -> None:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                _TOKEN_URL,
                data={
                    "grant_type": "refresh_token",
                    "client_id": self._api_key,
                    "refresh_token": self._refresh_token_val,
                },
            )
            resp.raise_for_status()
            self._access_token = resp.json()["access_token"]

    async def _get(
        self,
        client: httpx.AsyncClient,
        url: str,
        params: dict[str, Any],
    ) -> httpx.Response:
        async with self._semaphore:
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

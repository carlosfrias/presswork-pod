"""Etsy OAuth token persistence on Supabase config table.

Tokens (access + refresh + expiry) rotate every hour and the refresh_token
itself rotates on use. Storing them only in env vars or process memory means
the rotated refresh_token from the latest call is lost on restart, dooming
the next refresh to fail with invalid_grant.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any, cast

from packages.shared_py.config import get_settings
from supabase import Client

_CONFIG_KEY = "etsy_oauth"

# In-process lock coalesces concurrent refresh requests inside a single agent
# process. Cross-process serialization still relies on Etsy rejecting old
# refresh tokens on the second attempt; that's the existing failure mode.
_REFRESH_LOCK = asyncio.Lock()


class EtsyTokens:
    __slots__ = ("access_token", "refresh_token", "expires_at")

    def __init__(self, access_token: str, refresh_token: str, expires_at: datetime) -> None:
        self.access_token = access_token
        self.refresh_token = refresh_token
        self.expires_at = expires_at


def get_refresh_lock() -> asyncio.Lock:
    """Module-level lock so callers in the same process serialize refreshes."""
    return _REFRESH_LOCK


def load_tokens(db: Client) -> EtsyTokens:
    """Read tokens from Supabase config, falling back to env-var seed values.

    The first call after deploy hits the env-var path and stores expiry=0 so
    the next API call triggers a refresh that persists the rotated values.
    """
    resp = db.table("config").select("value").eq("key", _CONFIG_KEY).execute()
    if resp.data:
        # The config.etsy_oauth row is a shared cross-language contract: the TS
        # agents (Listing/Ledger) read and write it with camelCase keys
        # (see packages/shared/src/etsy-tokens.ts). Python must use the same
        # shape or it can't read tokens the TS refresher rotated.
        value = cast(dict[str, Any], resp.data[0]["value"])
        return EtsyTokens(
            access_token=value["accessToken"],
            refresh_token=value["refreshToken"],
            expires_at=datetime.fromisoformat(value["expiresAt"]),
        )

    settings = get_settings()
    return EtsyTokens(
        access_token=settings.etsy_access_token,
        refresh_token=settings.etsy_refresh_token,
        # Epoch — treated as already expired so the first call forces a refresh.
        expires_at=datetime.fromtimestamp(0, tz=UTC),
    )


def save_tokens(db: Client, tokens: EtsyTokens) -> None:
    db.table("config").upsert(
        {
            "key": _CONFIG_KEY,
            # camelCase to match the TS token contract — see load_tokens above.
            "value": {
                "accessToken": tokens.access_token,
                "refreshToken": tokens.refresh_token,
                "expiresAt": tokens.expires_at.isoformat(),
            },
        },
        on_conflict="key",
    ).execute()


def tokens_from_response(payload: dict[str, Any]) -> EtsyTokens:
    """Build an EtsyTokens from an Etsy /oauth/token response body.

    Etsy rotates refresh_token on every refresh — failing to capture the new
    value here permanently breaks the next refresh.
    """
    expires_in = int(payload.get("expires_in", 3600))
    return EtsyTokens(
        access_token=payload["access_token"],
        refresh_token=payload["refresh_token"],
        expires_at=datetime.now(tz=UTC) + timedelta(seconds=expires_in),
    )

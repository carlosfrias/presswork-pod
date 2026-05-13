"""Service-role Supabase client, lazily constructed and process-scoped.

The client is constructed once per process on first call and reused.
Agents are short-lived crons, so the singleton lifetime matches the
agent run; there is no cross-process sharing.

A previous version used ``@lru_cache`` on ``get_db``. That worked but
hid the caching from the rest of the codebase and had no test reset
path beyond ``get_db.cache_clear()`` (an lru_cache implementation
detail). This module exposes an explicit ``_reset_db_client()`` for
test isolation; production code should never call it.

Reconnect-on-error is intentionally not implemented here. If a
long-running Design agent ever hits a dead httpx session mid-pipeline,
revisit this — see AUDIT_4 C4 follow-up notes.
"""

from __future__ import annotations

import base64
import json

from supabase import Client, create_client

from .config import get_settings

_db_client: Client | None = None


def _is_service_role_key(key: str) -> bool:
    # Supabase CLI v2.99+ (beta) uses sb_secret_... keys instead of JWTs for local dev
    if key.startswith("sb_secret_"):
        return True
    # Production keys are JWTs — decode payload and check role claim
    try:
        payload_b64 = key.split(".")[1]
        padding = 4 - len(payload_b64) % 4
        if padding != 4:
            payload_b64 += "=" * padding
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
        return payload.get("role") == "service_role"
    except (IndexError, ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return False


def get_db() -> Client:
    global _db_client
    if _db_client is None:
        settings = get_settings()
        key = settings.supabase_service_role_key
        if not _is_service_role_key(key):
            raise RuntimeError(
                "SUPABASE_SERVICE_ROLE_KEY does not appear to be a service role key. "
                "Check that you are not using the anon key."
            )
        _db_client = create_client(str(settings.supabase_url), key)
    return _db_client


def _reset_db_client() -> None:
    """Test-only — clears the cached Supabase client so the next ``get_db``
    call rebuilds from current settings. Production code should not call
    this; the singleton is intentionally process-scoped.
    """
    global _db_client
    _db_client = None

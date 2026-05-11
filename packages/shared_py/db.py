import base64
import json
from functools import lru_cache

from supabase import Client, create_client

from .config import get_settings


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


@lru_cache
def get_db() -> Client:
    settings = get_settings()
    key = settings.supabase_service_role_key
    if not _is_service_role_key(key):
        raise RuntimeError(
            "SUPABASE_SERVICE_ROLE_KEY does not appear to be a service role key. "
            "Check that you are not using the anon key."
        )
    return create_client(str(settings.supabase_url), key)

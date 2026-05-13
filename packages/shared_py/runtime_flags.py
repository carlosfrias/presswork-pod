"""Dashboard-controlled runtime flags backed by the `runtime_flags` table.

Each agent reads flag values at the start of a run via `get_runtime_flag`,
falling back to the provided default if the row is missing or the read fails.
Values are cached per process; agents are short-lived crons so they pick up
new dashboard toggles on the next scheduled run.
"""

from __future__ import annotations

from .db import get_db
from .logger import get_logger

_log = get_logger("shared")
_cache: dict[str, object] = {}


def get_runtime_flag[T: (bool, int, float, str)](key: str, fallback: T) -> T:
    if key in _cache:
        return _cache[key]  # type: ignore[return-value]
    try:
        resp = (
            get_db().table("runtime_flags").select("value").eq("key", key).maybe_single().execute()
        )
        if resp is None or not getattr(resp, "data", None):
            _cache[key] = fallback
            return fallback
        value = resp.data["value"]  # JSONB → native python type
        _cache[key] = value
        return value  # type: ignore[return-value]
    except Exception as exc:  # noqa: BLE001
        _log.warning("runtime_flag_read_failed", key=key, error=str(exc))
        _cache[key] = fallback
        return fallback


def _reset_runtime_flag_cache() -> None:
    """Test-only — clears the in-process cache."""
    _cache.clear()

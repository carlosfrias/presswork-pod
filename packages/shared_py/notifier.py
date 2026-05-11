import logging
from typing import Literal

import httpx

from packages.shared_py.config import get_settings

_log = logging.getLogger("notifier")

_SEVERITY_ICONS = {
    "info": ":white_circle:",
    "warn": ":warning:",
    "error": ":red_circle:",
}


async def notify_slack(
    message: str,
    severity: Literal["info", "warn", "error"] = "info",
) -> None:
    try:
        settings = get_settings()
        url = settings.slack_webhook_url
    except Exception as exc:
        # Surface the underlying error so missing-env-var failures don't silently
        # disable critical alerts (e.g. retry_count >= 3). We still swallow the
        # exception because alerting must never crash the caller.
        _log.warning("[notifier] Failed to load settings — skipping Slack alert: %s", exc)
        return

    if not url:
        _log.warning("[notifier] SLACK_WEBHOOK_URL not set — skipping Slack alert")
        return

    try:
        icon = _SEVERITY_ICONS.get(severity, ":white_circle:")
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(url, json={"text": f"{icon} {message}"})
            if not resp.is_success:
                _log.warning("[notifier] Slack POST returned %s", resp.status_code)
    except Exception as exc:
        _log.warning("[notifier] Slack POST failed: %s", exc)

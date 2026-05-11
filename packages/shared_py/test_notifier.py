import httpx
import pytest
import respx

from packages.shared_py.notifier import notify_slack

_WEBHOOK_URL = "https://hooks.slack.com/services/TEST/WEBHOOK"


@pytest.mark.asyncio
async def test_no_op_when_url_unset(mocker, caplog):
    settings = mocker.MagicMock()
    settings.slack_webhook_url = None
    mocker.patch("packages.shared_py.notifier.get_settings", return_value=settings)

    import logging

    with caplog.at_level(logging.WARNING, logger="notifier"):
        await notify_slack("hello")

    assert "SLACK_WEBHOOK_URL not set" in caplog.text


@pytest.mark.asyncio
@respx.mock
async def test_posts_to_webhook_when_url_set(mocker):
    settings = mocker.MagicMock()
    settings.slack_webhook_url = _WEBHOOK_URL
    mocker.patch("packages.shared_py.notifier.get_settings", return_value=settings)

    route = respx.post(_WEBHOOK_URL).mock(return_value=httpx.Response(200))

    await notify_slack("alert!", severity="error")

    assert route.called
    payload = route.calls[0].request.content
    assert b":red_circle:" in payload
    assert b"alert!" in payload


@pytest.mark.asyncio
@respx.mock
async def test_swallows_http_500_silently(mocker):
    settings = mocker.MagicMock()
    settings.slack_webhook_url = _WEBHOOK_URL
    mocker.patch("packages.shared_py.notifier.get_settings", return_value=settings)

    respx.post(_WEBHOOK_URL).mock(return_value=httpx.Response(500))

    await notify_slack("something failed", severity="error")


@pytest.mark.asyncio
async def test_logs_underlying_exception_when_settings_fail(mocker, caplog):
    """Audit #45: bare except previously hid the underlying error.

    The settings-load failure must surface in logs so missing-env-var problems
    don't silently disable the retry_count >= 3 alert.
    """
    mocker.patch(
        "packages.shared_py.notifier.get_settings",
        side_effect=ValueError("missing SUPABASE_URL"),
    )

    import logging

    with caplog.at_level(logging.WARNING, logger="notifier"):
        await notify_slack("ceiling reached")

    assert "Failed to load settings" in caplog.text
    assert "missing SUPABASE_URL" in caplog.text

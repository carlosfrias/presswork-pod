from unittest.mock import AsyncMock, MagicMock

import pytest

from packages.scout.main import run


def _make_analysis():
    analysis = MagicMock()
    analysis.model_dump.return_value = {
        "niche": "test-niche",
        "style_keywords": ["bold"],
        "top_tags": ["tag1"],
        "price_target_usd": 24.99,
        "color_palette": ["black"],
    }
    return analysis


@pytest.mark.asyncio
async def test_scout_failure_sends_slack_alert(mocker):
    error = RuntimeError("etsy down")

    mocker.patch("packages.scout.main.get_db", return_value=MagicMock())
    mocker.patch("packages.scout.main.is_recent_duplicate", return_value=False)
    mocker.patch("packages.scout.main.EtsyClient", return_value=MagicMock(
        fetch_top_listings=AsyncMock(side_effect=error)
    ))

    mock_notify = AsyncMock()
    mocker.patch("packages.scout.main.notify_slack", mock_notify)

    mocker.patch("packages.scout.main.NICHE_SEEDS", ["test-niche"])

    await run()

    mock_notify.assert_called_once()
    call_args = mock_notify.call_args
    assert call_args.kwargs.get("severity") == "error" or call_args.args[1] == "error"
    assert "test-niche" in call_args.args[0]

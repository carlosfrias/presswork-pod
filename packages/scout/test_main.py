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


def _patch_pipeline(mocker, *, rpc_result, niches=("test-niche",)):
    """Wire up the common Scout dependencies for a unit test.

    `rpc_result` is the object the supabase RPC call returns; the helper
    swaps the supabase Client mock so `db.rpc(...).execute()` returns it.
    """
    db = MagicMock()
    rpc_chain = MagicMock()
    rpc_chain.execute = MagicMock(return_value=rpc_result)
    db.rpc = MagicMock(return_value=rpc_chain)

    mocker.patch("packages.scout.main.get_db", return_value=db)
    mocker.patch("packages.scout.main.is_recent_duplicate", AsyncMock(return_value=False))
    mocker.patch(
        "packages.scout.main.is_semantic_duplicate",
        AsyncMock(return_value=(False, None)),
    )
    mocker.patch(
        "packages.scout.main.EtsyClient",
        return_value=MagicMock(fetch_top_listings=AsyncMock(return_value=[{"title": "x"}])),
    )
    mocker.patch("packages.scout.main.analyze_niche", AsyncMock(return_value=_make_analysis()))
    mocker.patch("packages.scout.main.NICHE_SEEDS", list(niches))
    mocker.patch("packages.scout.main.notify_slack", AsyncMock())
    return db


@pytest.mark.asyncio
async def test_scout_failure_sends_slack_alert(mocker):
    error = RuntimeError("etsy down")

    mocker.patch("packages.scout.main.get_db", return_value=MagicMock())
    mocker.patch("packages.scout.main.is_recent_duplicate", AsyncMock(return_value=False))
    mocker.patch(
        "packages.scout.main.EtsyClient",
        return_value=MagicMock(fetch_top_listings=AsyncMock(side_effect=error)),
    )

    mock_notify = AsyncMock()
    mocker.patch("packages.scout.main.notify_slack", mock_notify)

    mocker.patch("packages.scout.main.NICHE_SEEDS", ["test-niche"])

    await run()

    mock_notify.assert_called_once()
    call_args = mock_notify.call_args
    assert call_args.kwargs.get("severity") == "error" or call_args.args[1] == "error"
    assert "test-niche" in call_args.args[0]


@pytest.mark.asyncio
async def test_scout_inserts_via_atomic_rpc(mocker):
    # RPC happy path — returns the inserted row, Scout treats it as a fresh
    # insert and never falls through to a duplicate-skip log.
    rpc_result = MagicMock()
    rpc_result.data = [{"id": "11111111-1111-1111-1111-111111111111", "niche": "test-niche"}]
    db = _patch_pipeline(mocker, rpc_result=rpc_result)

    await run()

    db.rpc.assert_called_once()
    rpc_name, rpc_args = db.rpc.call_args.args[0], db.rpc.call_args.args[1]
    assert rpc_name == "insert_trend_brief_if_no_recent"
    payload = rpc_args["p_row"]
    assert payload["niche"] == "test-niche"
    assert payload["status"] == "needs_review"


@pytest.mark.asyncio
async def test_scout_skips_when_rpc_returns_null(mocker):
    # RPC lost the race — recent duplicate exists. Scout must NOT count this
    # as an insert and must move on without raising.
    rpc_result = MagicMock()
    rpc_result.data = None
    db = _patch_pipeline(mocker, rpc_result=rpc_result)

    notify = mocker.patch("packages.scout.main.notify_slack", AsyncMock())

    await run()

    db.rpc.assert_called_once()
    notify.assert_not_called()  # not an error — just a dedupe miss


@pytest.mark.asyncio
async def test_scout_skips_on_belt_index_unique_violation(mocker):
    # The belt UNIQUE (niche, day) index can fire even when the RPC says OK,
    # if two concurrent transactions race past the advisory lock window.
    # Scout should treat the 23505 as a duplicate-skip, not a hard failure.
    db = MagicMock()
    rpc_chain = MagicMock()
    rpc_chain.execute = MagicMock(
        side_effect=RuntimeError("duplicate key value violates unique constraint (code 23505)")
    )
    db.rpc = MagicMock(return_value=rpc_chain)

    mocker.patch("packages.scout.main.get_db", return_value=db)
    mocker.patch("packages.scout.main.is_recent_duplicate", AsyncMock(return_value=False))
    mocker.patch(
        "packages.scout.main.is_semantic_duplicate",
        AsyncMock(return_value=(False, None)),
    )
    mocker.patch(
        "packages.scout.main.EtsyClient",
        return_value=MagicMock(fetch_top_listings=AsyncMock(return_value=[{"title": "x"}])),
    )
    mocker.patch("packages.scout.main.analyze_niche", AsyncMock(return_value=_make_analysis()))
    mocker.patch("packages.scout.main.NICHE_SEEDS", ["test-niche"])
    notify = mocker.patch("packages.scout.main.notify_slack", AsyncMock())

    await run()

    # No Slack alert: a unique violation is the expected loss-of-race path.
    notify.assert_not_called()

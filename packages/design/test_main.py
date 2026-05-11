from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest

from packages.design.main import run
from packages.shared_py.models import FluxPrompt, TrendBrief

_FLUX_PROMPT = FluxPrompt(
    prompt="print on demand design, transparent background, high resolution, vector-style mountains",
    style_descriptors=["minimalist", "nature"],
)

_FAKE_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100


def _make_brief(retry_count: int = 0) -> TrendBrief:
    return TrendBrief(
        id=uuid4(),
        created_at=datetime.now(tz=UTC),
        updated_at=datetime.now(tz=UTC),
        status="processing",
        niche="test-niche",
        retry_count=retry_count,
    )


def _mock_db(existing_data: list, design_retry_count: int = 0) -> MagicMock:
    mock = MagicMock()
    dp_mock = MagicMock()
    tb_mock = MagicMock()

    def table_side_effect(name: str) -> MagicMock:
        return dp_mock if name == "design_packages" else tb_mock

    mock.table.side_effect = table_side_effect

    # Different select paths return different shapes. The exception-handler
    # selects retry_count from design_packages; everything else uses the
    # same-row + cross-row dedup chain.
    def dp_select(fields: str) -> MagicMock:
        result = MagicMock()
        if "retry_count" in fields:
            result.eq.return_value.execute.return_value.data = (
                [{"retry_count": design_retry_count}] if design_retry_count > 0 else []
            )
        else:
            result.eq.return_value.execute.return_value.data = existing_data
            result.eq.return_value.not_.is_.return_value.order.return_value.limit.return_value.execute.return_value.data = []
        return result

    dp_mock.select.side_effect = dp_select
    return mock


@pytest.mark.asyncio
async def test_first_run_calls_fal_once(mocker):
    brief = _make_brief()
    db = _mock_db([])

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)
    mocker.patch("packages.design.main.build_flux_prompt", return_value=_FLUX_PROMPT)
    mocker.patch("packages.design.main.process_for_print", return_value=_FAKE_PNG)
    mocker.patch("packages.design.main.upload_design", return_value="https://storage.example.com/design.png")

    mock_generate = AsyncMock(return_value=_FAKE_PNG)
    mocker.patch("packages.design.main.generate_image", mock_generate)

    await run()

    mock_generate.assert_called_once()


@pytest.mark.asyncio
async def test_rerun_with_done_row_skips_fal(mocker):
    brief = _make_brief()
    existing = [{"id": str(uuid4()), "image_url": "https://storage.example.com/existing.png", "status": "done"}]
    db = _mock_db(existing)

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)

    mock_generate = AsyncMock()
    mocker.patch("packages.design.main.generate_image", mock_generate)

    await run()

    mock_generate.assert_not_called()


@pytest.mark.asyncio
async def test_no_slack_alert_below_retry_ceiling(mocker):
    brief = _make_brief()
    # design_packages.retry_count=1 → this failure will set it to 2 (still below ceiling)
    db = _mock_db([], design_retry_count=1)

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)
    mocker.patch("packages.design.main.build_flux_prompt", return_value=_FLUX_PROMPT)
    mocker.patch("packages.design.main.generate_image", AsyncMock(side_effect=RuntimeError("fal down")))

    mock_notify = AsyncMock()
    mocker.patch("packages.design.main.notify_slack", mock_notify)

    await run()

    mock_notify.assert_not_called()


@pytest.mark.asyncio
async def test_slack_alert_at_retry_ceiling(mocker):
    brief = _make_brief()
    # design_packages.retry_count=2 → this failure will set it to 3 (ceiling hit)
    db = _mock_db([], design_retry_count=2)

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)
    mocker.patch("packages.design.main.build_flux_prompt", return_value=_FLUX_PROMPT)
    mocker.patch("packages.design.main.generate_image", AsyncMock(side_effect=RuntimeError("fal down")))

    mock_notify = AsyncMock()
    mocker.patch("packages.design.main.notify_slack", mock_notify)

    await run()

    mock_notify.assert_called_once()
    assert mock_notify.call_args.kwargs.get("severity") == "error"


@pytest.mark.asyncio
async def test_design_package_marked_error_on_failure(mocker):
    """Bug #9: design_packages must not be left in 'processing' on failure."""
    brief = _make_brief()
    db = _mock_db([], design_retry_count=0)

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)
    mocker.patch("packages.design.main.build_flux_prompt", return_value=_FLUX_PROMPT)
    mocker.patch("packages.design.main.generate_image", AsyncMock(side_effect=RuntimeError("fal down")))
    mocker.patch("packages.design.main.notify_slack", AsyncMock())

    await run()

    # design_packages.upsert(...) called with status='error' in the catch path
    dp_mock = db.table("design_packages")
    upsert_calls = dp_mock.upsert.call_args_list
    error_upserts = [
        call for call in upsert_calls if call.args and call.args[0].get("status") == "error"
    ]
    assert len(error_upserts) == 1, f"Expected 1 error upsert, got {len(error_upserts)}"


@pytest.mark.asyncio
async def test_trend_briefs_retry_count_not_incremented(mocker):
    """Bug #9: design failures must NOT increment trend_briefs.retry_count."""
    brief = _make_brief()
    db = _mock_db([], design_retry_count=0)

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)
    mocker.patch("packages.design.main.build_flux_prompt", return_value=_FLUX_PROMPT)
    mocker.patch("packages.design.main.generate_image", AsyncMock(side_effect=RuntimeError("fal down")))
    mocker.patch("packages.design.main.notify_slack", AsyncMock())

    await run()

    tb_mock = db.table("trend_briefs")
    for call in tb_mock.update.call_args_list:
        if call.args:
            assert "retry_count" not in call.args[0], (
                f"trend_briefs.update should not touch retry_count, got {call.args[0]}"
            )


@pytest.mark.asyncio
async def test_cross_row_dedup_skips_fal_on_second_brief(mocker):
    """Two briefs with the same fal prompt: fal.ai called once, second brief hits cache."""
    CACHED_IMAGE_URL = "https://storage.example.com/cached-design.png"
    brief1 = _make_brief()
    brief2 = _make_brief()

    db = MagicMock()
    tb_mock = MagicMock()

    brief1_dedup_done = {"done": False}

    def dp_select(fields: str):
        result = MagicMock()
        if "image_url,status" in fields or "id,image_url" in fields:
            # Same-row guard: always no match
            result.eq.return_value.execute.return_value.data = []
        else:
            # Cross-row dedup select
            chain = MagicMock()
            if brief1_dedup_done["done"]:
                # Second brief — return cache hit
                chain.order.return_value.limit.return_value.execute.return_value.data = [
                    {"image_url": CACHED_IMAGE_URL, "mockup_urls": None}
                ]
            else:
                # First brief — no cache hit
                chain.order.return_value.limit.return_value.execute.return_value.data = []
            result.eq.return_value.not_.is_.return_value = chain
        return result

    dp_mock = MagicMock()
    dp_mock.select.side_effect = dp_select

    def table_side_effect(name: str) -> MagicMock:
        return dp_mock if name == "design_packages" else tb_mock

    db.table.side_effect = table_side_effect

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief1, brief2, None])
    mocker.patch("packages.design.main.get_db", return_value=db)
    mocker.patch("packages.design.main.build_flux_prompt", return_value=_FLUX_PROMPT)
    mocker.patch("packages.design.main.process_for_print", return_value=_FAKE_PNG)

    def upload_side_effect(*args, **kwargs):
        brief1_dedup_done["done"] = True  # after brief1 uploads, mark cache as available
        return CACHED_IMAGE_URL

    mocker.patch("packages.design.main.upload_design", side_effect=upload_side_effect)

    mock_generate = AsyncMock(return_value=_FAKE_PNG)
    mocker.patch("packages.design.main.generate_image", mock_generate)

    await run()

    mock_generate.assert_called_once()

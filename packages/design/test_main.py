from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest

from packages.design.main import run
from packages.shared_py.models import FluxPrompt, PrintStyle, TrendBrief

_FLUX_PROMPT = FluxPrompt(
    prompt="print on demand design, transparent background, high resolution, vector-style mountains",
    style_descriptors=["minimalist", "nature"],
)

_FAKE_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
_UPSCALED_PNG = b"\x89PNG\r\n\x1a\n" + b"\xff" * 400


@pytest.fixture(autouse=True)
def _mock_settings_and_upscale(mocker):
    """Default mocks for the upscaler step. get_settings() returns
    upscaler_enabled=True; upscale_image is a passthrough AsyncMock that
    returns _UPSCALED_PNG. Individual tests override these as needed.

    Autouse so every pre-existing test that exercises the happy path through
    main.run() doesn't try to load real settings or hit fal.ai's upscaler.
    """
    settings = MagicMock()
    settings.upscaler_enabled = True
    mocker.patch("packages.design.main.get_settings", return_value=settings)
    mocker.patch("packages.design.main.upscale_image", AsyncMock(return_value=_UPSCALED_PNG))


def _make_brief(retry_count: int = 0, print_style: PrintStyle | None = None) -> TrendBrief:
    return TrendBrief(
        id=uuid4(),
        created_at=datetime.now(tz=UTC),
        updated_at=datetime.now(tz=UTC),
        status="processing",
        niche="test-niche",
        retry_count=retry_count,
        print_style=print_style,
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


class _ChainRecorder:
    """Records the sequence of method names called on a fluent supabase-py
    builder. Each chained call appends to `.calls`. Audit #48: lets tests
    assert that production code emits the documented call order, so reordering
    .eq/.gte/.not_/.is_/.order/.limit/.execute is loud, not silent.
    """

    def __init__(self, return_data: list | None = None):
        self.calls: list[str] = []
        self._return_data = return_data or []

    def __getattr__(self, name: str):
        if name == "data":
            return self._return_data
        # `not_` is accessed as an attribute then `.is_(...)` is called; record
        # the attribute access so the chain reflects the production code shape.
        if name == "not_":
            self.calls.append("not_")
            return self

        def _method(*args, **kwargs):
            self.calls.append(name)
            return self

        return _method


@pytest.mark.asyncio
async def test_first_run_calls_fal_once(mocker):
    brief = _make_brief()
    db = _mock_db([])

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)
    mocker.patch("packages.design.main.build_flux_prompt", return_value=_FLUX_PROMPT)
    mocker.patch("packages.design.main.process_for_print", return_value=_FAKE_PNG)
    mocker.patch(
        "packages.design.main.upload_design", return_value="https://storage.example.com/design.png"
    )

    mock_generate = AsyncMock(return_value=_FAKE_PNG)
    mocker.patch("packages.design.main.generate_image", mock_generate)

    await run()

    mock_generate.assert_called_once()


@pytest.mark.asyncio
async def test_rerun_with_done_row_skips_fal(mocker):
    brief = _make_brief()
    existing = [
        {
            "id": str(uuid4()),
            "image_url": "https://storage.example.com/existing.png",
            "status": "done",
        }
    ]
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
    mocker.patch(
        "packages.design.main.generate_image", AsyncMock(side_effect=RuntimeError("fal down"))
    )

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
    mocker.patch(
        "packages.design.main.generate_image", AsyncMock(side_effect=RuntimeError("fal down"))
    )

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
    mocker.patch(
        "packages.design.main.generate_image", AsyncMock(side_effect=RuntimeError("fal down"))
    )
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
    mocker.patch(
        "packages.design.main.generate_image", AsyncMock(side_effect=RuntimeError("fal down"))
    )
    mocker.patch("packages.design.main.notify_slack", AsyncMock())

    await run()

    tb_mock = db.table("trend_briefs")
    for call in tb_mock.update.call_args_list:
        if call.args:
            assert "retry_count" not in call.args[0], (
                f"trend_briefs.update should not touch retry_count, got {call.args[0]}"
            )


@pytest.mark.asyncio
async def test_cross_row_dedup_chain_matches_production(mocker):
    """Audit #48: the cross-row dedup mock chain in _mock_db hardcodes
    .eq().not_.is_().order().limit().execute(). Verify production main.run()
    actually emits that exact sequence (after the same-row .eq().execute()
    prefix), so any future reorder fails this test loudly instead of silently
    yielding None from the mock.
    """
    brief = _make_brief()

    # Replace the design_packages mock with a recorder so we capture the real
    # call sequence emitted by production main.run() on the cross-row select.
    same_row = _ChainRecorder([])  # no existing row
    cross_row = _ChainRecorder([])  # no cache hit
    retry = _ChainRecorder([])  # no retry row

    select_calls: list[_ChainRecorder] = []

    def dp_select(fields: str) -> _ChainRecorder:
        if "retry_count" in fields:
            select_calls.append(retry)
            return retry
        if "image_url,mockup_urls" in fields:
            select_calls.append(cross_row)
            return cross_row
        select_calls.append(same_row)
        return same_row

    db = MagicMock()
    dp_mock = MagicMock()
    dp_mock.select.side_effect = dp_select
    tb_mock = MagicMock()

    def table_side_effect(name: str) -> MagicMock:
        return dp_mock if name == "design_packages" else tb_mock

    db.table.side_effect = table_side_effect

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)
    mocker.patch("packages.design.main.build_flux_prompt", return_value=_FLUX_PROMPT)
    mocker.patch("packages.design.main.process_for_print", return_value=_FAKE_PNG)
    mocker.patch(
        "packages.design.main.upload_design", return_value="https://storage.example.com/design.png"
    )
    mocker.patch("packages.design.main.generate_image", AsyncMock(return_value=_FAKE_PNG))

    await run()

    # Same-row check: select("id,image_url,status") → .eq() → .execute()
    assert same_row.calls == ["eq", "execute"], (
        f"same-row chain changed: {same_row.calls} (audit #48 — update _mock_db too)"
    )
    # Cross-row dedup: select("image_url,mockup_urls") → .eq() → .not_ → .is_()
    # → .order() → .limit() → .execute()
    assert cross_row.calls == [
        "eq",
        "not_",
        "is_",
        "order",
        "limit",
        "execute",
    ], f"cross-row dedup chain changed: {cross_row.calls} (audit #48 — update _mock_db too)"


@pytest.mark.asyncio
async def test_screen_print_brief_dispatches_screen_print_mode(mocker):
    """A brief with print_style='screen_print' must invoke process_for_print(mode='screen_print')."""
    brief = _make_brief(print_style="screen_print")
    db = _mock_db([])

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)
    mocker.patch("packages.design.main.build_flux_prompt", return_value=_FLUX_PROMPT)
    mock_process = mocker.patch("packages.design.main.process_for_print", return_value=_FAKE_PNG)
    mocker.patch(
        "packages.design.main.upload_design", return_value="https://storage.example.com/design.png"
    )
    mocker.patch("packages.design.main.generate_image", AsyncMock(return_value=_FAKE_PNG))

    await run()

    mock_process.assert_called_once()
    assert mock_process.call_args.kwargs.get("mode") == "screen_print", (
        f"expected mode='screen_print', got {mock_process.call_args.kwargs}"
    )


@pytest.mark.asyncio
async def test_null_print_style_defaults_to_full_color(mocker):
    """Legacy briefs with print_style=None must route to full_color (existing behavior)."""
    brief = _make_brief(print_style=None)
    db = _mock_db([])

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)
    mocker.patch("packages.design.main.build_flux_prompt", return_value=_FLUX_PROMPT)
    mock_process = mocker.patch("packages.design.main.process_for_print", return_value=_FAKE_PNG)
    mocker.patch(
        "packages.design.main.upload_design", return_value="https://storage.example.com/design.png"
    )
    mocker.patch("packages.design.main.generate_image", AsyncMock(return_value=_FAKE_PNG))

    await run()

    mock_process.assert_called_once()
    assert mock_process.call_args.kwargs.get("mode") == "full_color"


@pytest.mark.asyncio
async def test_full_color_brief_dispatches_full_color_mode(mocker):
    brief = _make_brief(print_style="full_color")
    db = _mock_db([])

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)
    mocker.patch("packages.design.main.build_flux_prompt", return_value=_FLUX_PROMPT)
    mock_process = mocker.patch("packages.design.main.process_for_print", return_value=_FAKE_PNG)
    mocker.patch(
        "packages.design.main.upload_design", return_value="https://storage.example.com/design.png"
    )
    mocker.patch("packages.design.main.generate_image", AsyncMock(return_value=_FAKE_PNG))

    await run()

    mock_process.assert_called_once()
    assert mock_process.call_args.kwargs.get("mode") == "full_color"


@pytest.mark.asyncio
async def test_upscaler_called_when_enabled(mocker):
    """When upscaler_enabled=True, the FLUX output flows through upscale_image
    and the upscaled bytes are what process_for_print receives."""
    brief = _make_brief()
    db = _mock_db([])

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)
    mocker.patch("packages.design.main.build_flux_prompt", return_value=_FLUX_PROMPT)
    mock_process = mocker.patch("packages.design.main.process_for_print", return_value=_FAKE_PNG)
    mocker.patch(
        "packages.design.main.upload_design", return_value="https://storage.example.com/design.png"
    )
    mocker.patch("packages.design.main.generate_image", AsyncMock(return_value=_FAKE_PNG))
    mock_upscale = AsyncMock(return_value=_UPSCALED_PNG)
    mocker.patch("packages.design.main.upscale_image", mock_upscale)

    await run()

    mock_upscale.assert_called_once_with(_FAKE_PNG)
    # process_for_print sees the upscaled bytes, not the original FLUX output.
    assert mock_process.call_args.args[0] == _UPSCALED_PNG


@pytest.mark.asyncio
async def test_upscaler_disabled_skips_step(mocker):
    """upscaler_enabled=False bypasses upscale_image entirely. process_for_print
    receives the raw FLUX output (current pre-upscaler behavior)."""
    brief = _make_brief()
    db = _mock_db([])

    settings = MagicMock()
    settings.upscaler_enabled = False
    mocker.patch("packages.design.main.get_settings", return_value=settings)

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)
    mocker.patch("packages.design.main.build_flux_prompt", return_value=_FLUX_PROMPT)
    mock_process = mocker.patch("packages.design.main.process_for_print", return_value=_FAKE_PNG)
    mocker.patch(
        "packages.design.main.upload_design", return_value="https://storage.example.com/design.png"
    )
    mocker.patch("packages.design.main.generate_image", AsyncMock(return_value=_FAKE_PNG))
    mock_upscale = AsyncMock(return_value=_UPSCALED_PNG)
    mocker.patch("packages.design.main.upscale_image", mock_upscale)

    await run()

    mock_upscale.assert_not_called()
    assert mock_process.call_args.args[0] == _FAKE_PNG


@pytest.mark.asyncio
async def test_upscaler_soft_failure_falls_back(mocker):
    """When upscale_image raises, the design still completes using the
    pre-upscale bytes, status hits 'done', and a Slack warning is posted.
    The 3-retry budget is NOT consumed (no design_packages.upsert with status='error')."""
    brief = _make_brief()
    db = _mock_db([])

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)
    mocker.patch("packages.design.main.build_flux_prompt", return_value=_FLUX_PROMPT)
    mock_process = mocker.patch("packages.design.main.process_for_print", return_value=_FAKE_PNG)
    mocker.patch(
        "packages.design.main.upload_design", return_value="https://storage.example.com/design.png"
    )
    mocker.patch("packages.design.main.generate_image", AsyncMock(return_value=_FAKE_PNG))
    mocker.patch(
        "packages.design.main.upscale_image",
        AsyncMock(side_effect=RuntimeError("aura-sr 503")),
    )
    mock_notify = AsyncMock()
    mocker.patch("packages.design.main.notify_slack", mock_notify)

    await run()

    # Pipeline continued past the upscaler with the original FLUX bytes.
    assert mock_process.call_args.args[0] == _FAKE_PNG

    # Slack warn alert fired (severity must be "warn", not "error").
    mock_notify.assert_called_once()
    assert mock_notify.call_args.kwargs.get("severity") == "warn"

    # No error upsert — soft fail must not consume the retry budget.
    dp_mock = db.table("design_packages")
    error_upserts = [
        call
        for call in dp_mock.upsert.call_args_list
        if call.args and call.args[0].get("status") == "error"
    ]
    assert error_upserts == [], f"soft-fail must not write status=error, got {error_upserts}"


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

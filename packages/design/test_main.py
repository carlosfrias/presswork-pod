from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest

from packages.design.main import run
from packages.shared_py.models import FluxPrompt, ImageModel, ImagePrompt, TrendBrief

_FLUX_PROMPT = FluxPrompt(
    prompt="print on demand design, vector-style mountains, white background",
    style_descriptors=["minimalist", "nature"],
)

# URL-threaded pipeline: every fal stage exchanges URLs, never bytes. The only
# bytes that flow through Python are the single download just before
# process_for_print and the upload to Supabase Storage.
_FAKE_FLUX_URL = "https://fal.media/files/flux/output.png"
_FAKE_UPSCALED_URL = "https://cdn.fal.ai/aura-sr/upscaled.png"
_FAKE_BIREFNET_URL = "https://cdn.fal.ai/birefnet/transparent.png"
_FAKE_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100


@pytest.fixture(autouse=True)
def _mock_settings_and_fal_chain(mocker):
    """Default mocks for the full URL pipeline. get_settings() returns
    upscaler_enabled=True, background_removal_mode="birefnet" (matches the
    production default after the birefnet rollout). Each fal stage is patched
    to a passthrough AsyncMock returning a fake URL. download_image returns
    _FAKE_PNG. Individual tests override these as needed.

    Autouse so every pre-existing test that exercises the happy path through
    main.run() doesn't try to load real settings or hit fal.ai.
    """
    settings = MagicMock()
    settings.upscaler_enabled = True
    settings.background_removal_mode = "birefnet"
    mocker.patch("packages.design.main.get_settings", return_value=settings)
    # Passthrough runtime_flags reads: yield the env-fallback (settings.*) value
    # rather than hitting Supabase. Tests that need a specific flag override it
    # via mocker.patch("packages.design.main.get_runtime_flag", ...).
    mocker.patch(
        "packages.design.main.get_runtime_flag",
        side_effect=lambda _key, fallback: fallback,
    )
    mocker.patch(
        "packages.design.main.upscale_url",
        AsyncMock(return_value=_FAKE_UPSCALED_URL),
    )
    mocker.patch(
        "packages.design.main.remove_background_birefnet_url",
        AsyncMock(return_value=_FAKE_BIREFNET_URL),
    )
    mocker.patch(
        "packages.design.main.remove_background_bria_url",
        AsyncMock(return_value=_FAKE_BIREFNET_URL),
    )
    mocker.patch(
        "packages.design.main.download_image",
        AsyncMock(return_value=_FAKE_PNG),
    )


def _make_brief(
    retry_count: int = 0,
    image_model: ImageModel = "fal_flux_pro",
) -> TrendBrief:
    """Default image_model is fal_flux_pro to preserve the FLUX-pipeline test
    semantics this suite was originally written against. Pass
    image_model="fal_gpt_image_2" to exercise the new backend path."""
    return TrendBrief(
        id=uuid4(),
        created_at=datetime.now(tz=UTC),
        updated_at=datetime.now(tz=UTC),
        status="processing",
        niche="test-niche",
        retry_count=retry_count,
        image_model=image_model,
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
    mocker.patch("packages.design.main.build_image_prompt", return_value=_FLUX_PROMPT)
    mocker.patch("packages.design.main.process_for_print", return_value=_FAKE_PNG)
    mocker.patch(
        "packages.design.main.upload_design", return_value="https://storage.example.com/design.png"
    )

    mock_generate = AsyncMock(return_value=_FAKE_FLUX_URL)
    mocker.patch("packages.design.main.generate_flux_image_url", mock_generate)

    await run()

    mock_generate.assert_called_once()


@pytest.mark.asyncio
async def test_url_pipeline_downloads_masked_and_premask(mocker):
    """The pipeline downloads bytes exactly twice now: once for the masked
    output (birefnet URL) and once for the pre-mask preview (the URL going
    INTO birefnet — post-upscaler on the FLUX path). The previous "exactly
    once" guarantee was relaxed in service of the Design page's mask-QA
    flip; the no-intermediate-rehydration property still holds (we don't
    re-download URL transitions we don't surface)."""
    brief = _make_brief()
    db = _mock_db([])

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)
    mocker.patch("packages.design.main.build_image_prompt", return_value=_FLUX_PROMPT)
    mocker.patch("packages.design.main.process_for_print", return_value=_FAKE_PNG)
    mocker.patch(
        "packages.design.main.upload_design", return_value="https://storage.example.com/design.png"
    )
    mocker.patch(
        "packages.design.main.generate_flux_image_url",
        AsyncMock(return_value=_FAKE_FLUX_URL),
    )

    # Re-patch download_image to a fresh mock so we can count calls cleanly.
    mock_download = AsyncMock(return_value=_FAKE_PNG)
    mocker.patch("packages.design.main.download_image", mock_download)

    await run()

    assert mock_download.call_count == 2, (
        f"expected 2 downloads (masked + pre-mask), got {mock_download.call_count}"
    )
    urls = [call.args[0] for call in mock_download.call_args_list]
    # Masked = birefnet output; pre-mask = the URL that went INTO birefnet
    # (post-upscaler on the FLUX path).
    assert _FAKE_BIREFNET_URL in urls
    assert _FAKE_UPSCALED_URL in urls


@pytest.mark.asyncio
async def test_url_threading_chain_order(mocker):
    """Each fal stage must receive the URL produced by the previous stage:
    FLUX → upscale_url → remove_background_birefnet_url → download_image."""
    brief = _make_brief()
    db = _mock_db([])

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)
    mocker.patch("packages.design.main.build_image_prompt", return_value=_FLUX_PROMPT)
    mocker.patch("packages.design.main.process_for_print", return_value=_FAKE_PNG)
    mocker.patch(
        "packages.design.main.upload_design", return_value="https://storage.example.com/design.png"
    )
    mocker.patch(
        "packages.design.main.generate_flux_image_url",
        AsyncMock(return_value=_FAKE_FLUX_URL),
    )
    mock_upscale = AsyncMock(return_value=_FAKE_UPSCALED_URL)
    mocker.patch("packages.design.main.upscale_url", mock_upscale)
    mock_birefnet = AsyncMock(return_value=_FAKE_BIREFNET_URL)
    mocker.patch("packages.design.main.remove_background_birefnet_url", mock_birefnet)

    await run()

    # upscale_url receives the FLUX output URL.
    mock_upscale.assert_called_once_with(_FAKE_FLUX_URL)
    # remove_background_birefnet_url receives the upscaled URL.
    mock_birefnet.assert_called_once_with(_FAKE_UPSCALED_URL)


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
    mocker.patch("packages.design.main.generate_flux_image_url", mock_generate)

    await run()

    mock_generate.assert_not_called()


@pytest.mark.asyncio
async def test_slack_alert_fires_on_every_design_failure(mocker):
    """Approved-and-failed briefs are terminal — no retry budget, no second
    chance. Every failure parks the brief at 'error' and pages the operator."""
    brief = _make_brief()
    db = _mock_db([], design_retry_count=0)

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)
    mocker.patch("packages.design.main.build_image_prompt", return_value=_FLUX_PROMPT)
    mocker.patch(
        "packages.design.main.generate_flux_image_url",
        AsyncMock(side_effect=RuntimeError("fal down")),
    )

    mock_notify = AsyncMock()
    mocker.patch("packages.design.main.notify_slack", mock_notify)

    await run()

    mock_notify.assert_called_once()
    assert mock_notify.call_args.kwargs.get("severity") == "error"


@pytest.mark.asyncio
async def test_failed_brief_lands_at_error_not_pending(mocker):
    """Once approved, a brief never reverts to 'pending'. Failures go straight
    to 'error' so the operator can inspect rather than letting the agent loop."""
    brief = _make_brief()
    db = _mock_db([], design_retry_count=0)

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)
    mocker.patch("packages.design.main.build_image_prompt", return_value=_FLUX_PROMPT)
    mocker.patch(
        "packages.design.main.generate_flux_image_url",
        AsyncMock(side_effect=RuntimeError("fal down")),
    )
    mocker.patch("packages.design.main.notify_slack", AsyncMock())

    await run()

    tb_mock = db.table("trend_briefs")
    statuses = [call.args[0].get("status") for call in tb_mock.update.call_args_list if call.args]
    assert "pending" not in statuses, (
        f"trend_briefs must not be reverted to 'pending' on design failure, got {statuses}"
    )
    assert "error" in statuses, (
        f"trend_briefs must be set to 'error' on design failure, got {statuses}"
    )


@pytest.mark.asyncio
async def test_design_package_marked_error_on_failure(mocker):
    """Bug #9: design_packages must not be left in 'processing' on failure."""
    brief = _make_brief()
    db = _mock_db([], design_retry_count=0)

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)
    mocker.patch("packages.design.main.build_image_prompt", return_value=_FLUX_PROMPT)
    mocker.patch(
        "packages.design.main.generate_flux_image_url",
        AsyncMock(side_effect=RuntimeError("fal down")),
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
    mocker.patch("packages.design.main.build_image_prompt", return_value=_FLUX_PROMPT)
    mocker.patch(
        "packages.design.main.generate_flux_image_url",
        AsyncMock(side_effect=RuntimeError("fal down")),
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
async def test_slack_alert_fires_even_when_select_retry_count_raises(mocker):
    """AUDIT_4 H7: if the SELECT retry_count call inside the exception
    handler itself raises, the brief used to stay stuck in 'processing'
    and no operator alert ever fired. The handler now wraps each
    secondary DB call in its own try/except so notify_slack always runs.
    """
    brief = _make_brief()

    # Custom db mock: dp_mock.select(...).eq(...).execute() raises. Everything
    # else still works so the test can reach the catch block normally.
    db = MagicMock()
    dp_mock = MagicMock()
    tb_mock = MagicMock()
    db.table.side_effect = lambda name: dp_mock if name == "design_packages" else tb_mock

    def dp_select(fields: str) -> MagicMock:
        result = MagicMock()
        if "retry_count" in fields:
            result.eq.return_value.execute.side_effect = RuntimeError("supabase timeout")
        else:
            result.eq.return_value.execute.return_value.data = []
            result.eq.return_value.not_.is_.return_value.order.return_value.limit.return_value.execute.return_value.data = []
        return result

    dp_mock.select.side_effect = dp_select

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)
    mocker.patch("packages.design.main.build_image_prompt", return_value=_FLUX_PROMPT)
    mocker.patch(
        "packages.design.main.generate_flux_image_url",
        AsyncMock(side_effect=RuntimeError("fal down")),
    )

    mock_notify = AsyncMock()
    mocker.patch("packages.design.main.notify_slack", mock_notify)

    await run()

    # Alert still fires even though _select_retry_count raised.
    mock_notify.assert_called_once()
    assert mock_notify.call_args.kwargs.get("severity") == "error"


@pytest.mark.asyncio
async def test_slack_alert_fires_even_when_design_upsert_raises(mocker):
    """AUDIT_4 H7: if the design_packages upsert inside the exception
    handler raises (e.g. transient transport error after RLS reload),
    the trend_briefs status flip and Slack alert must still execute."""
    brief = _make_brief()

    db = MagicMock()
    dp_mock = MagicMock()
    tb_mock = MagicMock()
    db.table.side_effect = lambda name: dp_mock if name == "design_packages" else tb_mock

    def dp_select(fields: str) -> MagicMock:
        result = MagicMock()
        if "retry_count" in fields:
            result.eq.return_value.execute.return_value.data = []
        else:
            result.eq.return_value.execute.return_value.data = []
            result.eq.return_value.not_.is_.return_value.order.return_value.limit.return_value.execute.return_value.data = []
        return result

    dp_mock.select.side_effect = dp_select
    # design_packages.upsert(...).execute() raises.
    dp_mock.upsert.return_value.execute.side_effect = RuntimeError("supabase write failed")

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)
    mocker.patch("packages.design.main.build_image_prompt", return_value=_FLUX_PROMPT)
    mocker.patch(
        "packages.design.main.generate_flux_image_url",
        AsyncMock(side_effect=RuntimeError("fal down")),
    )

    mock_notify = AsyncMock()
    mocker.patch("packages.design.main.notify_slack", mock_notify)

    await run()

    mock_notify.assert_called_once()
    assert mock_notify.call_args.kwargs.get("severity") == "error"

    # trend_briefs.update(status=error) must still have been attempted.
    update_statuses = [
        call.args[0].get("status")
        for call in tb_mock.update.call_args_list
        if call.args and isinstance(call.args[0], dict)
    ]
    assert "error" in update_statuses


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
        # Cross-row dedup pulls mockup_urls along with the image URLs.
        # Same-row select doesn't — it's "id,image_url,status".
        if "mockup_urls" in fields:
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
    mocker.patch("packages.design.main.build_image_prompt", return_value=_FLUX_PROMPT)
    mocker.patch("packages.design.main.process_for_print", return_value=_FAKE_PNG)
    mocker.patch(
        "packages.design.main.upload_design", return_value="https://storage.example.com/design.png"
    )
    mocker.patch(
        "packages.design.main.generate_flux_image_url", AsyncMock(return_value=_FAKE_FLUX_URL)
    )

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
async def test_upscaler_called_when_enabled(mocker):
    """When upscaler_enabled=True, the FLUX URL flows through upscale_url and
    the upscaled URL is what feeds into birefnet."""
    brief = _make_brief()
    db = _mock_db([])

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)
    mocker.patch("packages.design.main.build_image_prompt", return_value=_FLUX_PROMPT)
    mocker.patch("packages.design.main.process_for_print", return_value=_FAKE_PNG)
    mocker.patch(
        "packages.design.main.upload_design", return_value="https://storage.example.com/design.png"
    )
    mocker.patch(
        "packages.design.main.generate_flux_image_url", AsyncMock(return_value=_FAKE_FLUX_URL)
    )
    mock_upscale = AsyncMock(return_value=_FAKE_UPSCALED_URL)
    mocker.patch("packages.design.main.upscale_url", mock_upscale)
    mock_birefnet = AsyncMock(return_value=_FAKE_BIREFNET_URL)
    mocker.patch("packages.design.main.remove_background_birefnet_url", mock_birefnet)

    await run()

    mock_upscale.assert_called_once_with(_FAKE_FLUX_URL)
    # birefnet sees the upscaled URL, not the raw FLUX URL.
    mock_birefnet.assert_called_once_with(_FAKE_UPSCALED_URL)


@pytest.mark.asyncio
async def test_upscaler_disabled_skips_step(mocker):
    """upscaler_enabled=False bypasses upscale_url entirely. birefnet sees the
    raw FLUX URL directly."""
    brief = _make_brief()
    db = _mock_db([])

    settings = MagicMock()
    settings.upscaler_enabled = False
    settings.background_removal_mode = "birefnet"
    mocker.patch("packages.design.main.get_settings", return_value=settings)

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)
    mocker.patch("packages.design.main.build_image_prompt", return_value=_FLUX_PROMPT)
    mocker.patch("packages.design.main.process_for_print", return_value=_FAKE_PNG)
    mocker.patch(
        "packages.design.main.upload_design", return_value="https://storage.example.com/design.png"
    )
    mocker.patch(
        "packages.design.main.generate_flux_image_url", AsyncMock(return_value=_FAKE_FLUX_URL)
    )
    mock_upscale = AsyncMock(return_value=_FAKE_UPSCALED_URL)
    mocker.patch("packages.design.main.upscale_url", mock_upscale)
    mock_birefnet = AsyncMock(return_value=_FAKE_BIREFNET_URL)
    mocker.patch("packages.design.main.remove_background_birefnet_url", mock_birefnet)

    await run()

    mock_upscale.assert_not_called()
    # birefnet receives the FLUX URL directly when upscaler is disabled.
    mock_birefnet.assert_called_once_with(_FAKE_FLUX_URL)


@pytest.mark.asyncio
async def test_upscaler_soft_failure_falls_back(mocker):
    """When upscale_url raises, the design still completes using the pre-upscale
    FLUX URL, status hits 'done', and a Slack warning is posted. The 3-retry
    budget is NOT consumed (no design_packages.upsert with status='error')."""
    brief = _make_brief()
    db = _mock_db([])

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)
    mocker.patch("packages.design.main.build_image_prompt", return_value=_FLUX_PROMPT)
    mocker.patch("packages.design.main.process_for_print", return_value=_FAKE_PNG)
    mocker.patch(
        "packages.design.main.upload_design", return_value="https://storage.example.com/design.png"
    )
    mocker.patch(
        "packages.design.main.generate_flux_image_url", AsyncMock(return_value=_FAKE_FLUX_URL)
    )
    mocker.patch(
        "packages.design.main.upscale_url",
        AsyncMock(side_effect=RuntimeError("aura-sr 503")),
    )
    mock_birefnet = AsyncMock(return_value=_FAKE_BIREFNET_URL)
    mocker.patch("packages.design.main.remove_background_birefnet_url", mock_birefnet)
    mock_notify = AsyncMock()
    mocker.patch("packages.design.main.notify_slack", mock_notify)

    await run()

    # Pipeline continued past the upscaler: birefnet received the FLUX URL directly.
    mock_birefnet.assert_called_once_with(_FAKE_FLUX_URL)

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
    mocker.patch("packages.design.main.build_image_prompt", return_value=_FLUX_PROMPT)
    mocker.patch("packages.design.main.process_for_print", return_value=_FAKE_PNG)

    def upload_side_effect(*args, **kwargs):
        brief1_dedup_done["done"] = True  # after brief1 uploads, mark cache as available
        return CACHED_IMAGE_URL

    mocker.patch("packages.design.main.upload_design", side_effect=upload_side_effect)

    mock_generate = AsyncMock(return_value=_FAKE_FLUX_URL)
    mocker.patch("packages.design.main.generate_flux_image_url", mock_generate)

    await run()

    mock_generate.assert_called_once()


# ---------------------------------------------------------------------------
# Backend dispatch: fal_gpt_image_2 vs fal_flux_pro
# ---------------------------------------------------------------------------


_GPT_IMAGE_PROMPT = ImagePrompt(
    prompt="A single centered illustration of a dark fantasy adventurer.",
    style_descriptors=["dark", "fantasy"],
)
_FAKE_GPT_IMAGE_URL = "https://cdn.fal.ai/gpt-image-2/output.png"


@pytest.mark.asyncio
async def test_gpt_image_brief_dispatches_to_gpt_image_backend(mocker):
    brief = _make_brief(image_model="fal_gpt_image_2")
    db = _mock_db([])

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)
    mocker.patch("packages.design.main.build_image_prompt", return_value=_GPT_IMAGE_PROMPT)
    mocker.patch("packages.design.main.process_for_print", return_value=_FAKE_PNG)
    mocker.patch(
        "packages.design.main.upload_design",
        return_value="https://supabase.storage/designs/x.png",
    )

    flux_mock = AsyncMock(return_value=_FAKE_FLUX_URL)
    gpt_mock = AsyncMock(return_value=_FAKE_GPT_IMAGE_URL)
    mocker.patch("packages.design.main.generate_flux_image_url", flux_mock)
    mocker.patch("packages.design.main.generate_gpt_image_url", gpt_mock)

    await run()

    flux_mock.assert_not_called()
    gpt_mock.assert_called_once()
    # quality from brief.image_quality (None here → defers to client default)
    assert gpt_mock.call_args.kwargs.get("quality") is None


@pytest.mark.asyncio
async def test_gpt_image_brief_skips_upscaler(mocker):
    """gpt-image-2's 2560x3072 native is large enough that aura-sr is waste.
    The upscaler step must be skipped even when upscaler_enabled=True."""
    brief = _make_brief(image_model="fal_gpt_image_2")
    db = _mock_db([])

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)
    mocker.patch("packages.design.main.build_image_prompt", return_value=_GPT_IMAGE_PROMPT)
    mocker.patch("packages.design.main.process_for_print", return_value=_FAKE_PNG)
    mocker.patch(
        "packages.design.main.upload_design",
        return_value="https://supabase.storage/designs/x.png",
    )
    mocker.patch(
        "packages.design.main.generate_gpt_image_url",
        AsyncMock(return_value=_FAKE_GPT_IMAGE_URL),
    )

    upscale_mock = AsyncMock(return_value=_FAKE_UPSCALED_URL)
    mocker.patch("packages.design.main.upscale_url", upscale_mock)

    await run()

    upscale_mock.assert_not_called()


@pytest.mark.asyncio
async def test_gpt_image_brief_still_runs_birefnet(mocker):
    """birefnet stays in the pipeline for gpt-image-2 - it doesn't emit
    transparent PNG. Only aura-sr is gated on FLUX."""
    brief = _make_brief(image_model="fal_gpt_image_2")
    db = _mock_db([])

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)
    mocker.patch("packages.design.main.build_image_prompt", return_value=_GPT_IMAGE_PROMPT)
    mocker.patch("packages.design.main.process_for_print", return_value=_FAKE_PNG)
    mocker.patch(
        "packages.design.main.upload_design",
        return_value="https://supabase.storage/designs/x.png",
    )
    mocker.patch(
        "packages.design.main.generate_gpt_image_url",
        AsyncMock(return_value=_FAKE_GPT_IMAGE_URL),
    )

    birefnet_mock = AsyncMock(return_value=_FAKE_BIREFNET_URL)
    mocker.patch("packages.design.main.remove_background_birefnet_url", birefnet_mock)

    await run()

    birefnet_mock.assert_called_once()


@pytest.mark.asyncio
async def test_gpt_image_brief_forwards_image_quality_from_brief(mocker):
    brief = _make_brief(image_model="fal_gpt_image_2")
    brief = brief.model_copy(update={"image_quality": "high"})
    db = _mock_db([])

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)
    mocker.patch("packages.design.main.build_image_prompt", return_value=_GPT_IMAGE_PROMPT)
    mocker.patch("packages.design.main.process_for_print", return_value=_FAKE_PNG)
    mocker.patch(
        "packages.design.main.upload_design",
        return_value="https://supabase.storage/designs/x.png",
    )

    gpt_mock = AsyncMock(return_value=_FAKE_GPT_IMAGE_URL)
    mocker.patch("packages.design.main.generate_gpt_image_url", gpt_mock)

    await run()

    gpt_mock.assert_called_once()
    assert gpt_mock.call_args.kwargs["quality"] == "high"


def test_cache_hash_segregates_by_image_model():
    """Two identical prompts against different backends must produce different
    hashes - otherwise a FLUX-generated image would be cache-served to a
    gpt-image-2 brief."""
    import hashlib

    prompt = "A centered adventurer figure"
    h_flux = hashlib.sha256(f"fal_flux_pro:{prompt}".encode()).hexdigest()
    h_gpt = hashlib.sha256(f"fal_gpt_image_2:{prompt}".encode()).hexdigest()
    assert h_flux != h_gpt


# ---------------------------------------------------------------------------
# Background-removal mode dispatch (birefnet | bria)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mode_bria_dispatches_to_bria_not_birefnet(mocker):
    brief = _make_brief()
    db = _mock_db([])

    settings = MagicMock()
    settings.upscaler_enabled = True
    settings.background_removal_mode = "bria"
    mocker.patch("packages.design.main.get_settings", return_value=settings)
    mocker.patch(
        "packages.design.main.get_runtime_flag",
        side_effect=lambda _key, fallback: fallback,
    )

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)
    mocker.patch("packages.design.main.build_image_prompt", return_value=_FLUX_PROMPT)
    mocker.patch("packages.design.main.process_for_print", return_value=_FAKE_PNG)
    mocker.patch("packages.design.main.upload_design", return_value="https://x/y.png")
    mocker.patch(
        "packages.design.main.generate_flux_image_url",
        AsyncMock(return_value=_FAKE_FLUX_URL),
    )
    mocker.patch("packages.design.main.upscale_url", AsyncMock(return_value=_FAKE_UPSCALED_URL))

    mock_birefnet = AsyncMock(return_value=_FAKE_BIREFNET_URL)
    mock_bria = AsyncMock(return_value=_FAKE_BIREFNET_URL)
    mocker.patch("packages.design.main.remove_background_birefnet_url", mock_birefnet)
    mocker.patch("packages.design.main.remove_background_bria_url", mock_bria)

    await run()

    mock_bria.assert_called_once_with(_FAKE_UPSCALED_URL)
    mock_birefnet.assert_not_called()


@pytest.mark.asyncio
async def test_mode_birefnet_dispatches_to_birefnet_not_bria(mocker):
    brief = _make_brief()
    db = _mock_db([])

    settings = MagicMock()
    settings.upscaler_enabled = True
    settings.background_removal_mode = "birefnet"
    mocker.patch("packages.design.main.get_settings", return_value=settings)
    mocker.patch(
        "packages.design.main.get_runtime_flag",
        side_effect=lambda _key, fallback: fallback,
    )

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)
    mocker.patch("packages.design.main.build_image_prompt", return_value=_FLUX_PROMPT)
    mocker.patch("packages.design.main.process_for_print", return_value=_FAKE_PNG)
    mocker.patch("packages.design.main.upload_design", return_value="https://x/y.png")
    mocker.patch(
        "packages.design.main.generate_flux_image_url",
        AsyncMock(return_value=_FAKE_FLUX_URL),
    )
    mocker.patch("packages.design.main.upscale_url", AsyncMock(return_value=_FAKE_UPSCALED_URL))

    mock_birefnet = AsyncMock(return_value=_FAKE_BIREFNET_URL)
    mock_bria = AsyncMock(return_value=_FAKE_BIREFNET_URL)
    mocker.patch("packages.design.main.remove_background_birefnet_url", mock_birefnet)
    mocker.patch("packages.design.main.remove_background_bria_url", mock_bria)

    await run()

    mock_birefnet.assert_called_once_with(_FAKE_UPSCALED_URL)
    mock_bria.assert_not_called()


@pytest.mark.asyncio
async def test_runtime_flag_overrides_env_for_background_mode(mocker):
    """The runtime_flags row wins over the settings env default. Operator
    flipping the dashboard toggle to 'bria' must redirect today's run there
    even if the env was set to 'birefnet'."""
    brief = _make_brief()
    db = _mock_db([])

    settings = MagicMock()
    settings.upscaler_enabled = True
    settings.background_removal_mode = "birefnet"  # env default
    mocker.patch("packages.design.main.get_settings", return_value=settings)

    # runtime_flags returns "bria" — that should win.
    def fake_flag(key: str, fallback):
        return "bria" if key == "background_removal_mode" else fallback

    mocker.patch("packages.design.main.get_runtime_flag", side_effect=fake_flag)

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)
    mocker.patch("packages.design.main.build_image_prompt", return_value=_FLUX_PROMPT)
    mocker.patch("packages.design.main.process_for_print", return_value=_FAKE_PNG)
    mocker.patch("packages.design.main.upload_design", return_value="https://x/y.png")
    mocker.patch(
        "packages.design.main.generate_flux_image_url",
        AsyncMock(return_value=_FAKE_FLUX_URL),
    )
    mocker.patch("packages.design.main.upscale_url", AsyncMock(return_value=_FAKE_UPSCALED_URL))

    mock_birefnet = AsyncMock(return_value=_FAKE_BIREFNET_URL)
    mock_bria = AsyncMock(return_value=_FAKE_BIREFNET_URL)
    mocker.patch("packages.design.main.remove_background_birefnet_url", mock_birefnet)
    mocker.patch("packages.design.main.remove_background_bria_url", mock_bria)

    await run()

    mock_bria.assert_called_once()
    mock_birefnet.assert_not_called()

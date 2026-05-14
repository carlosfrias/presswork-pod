"""Tests for the re-mask sweep — the cheap regen path that re-runs only the
background-removal step on a completed design.

Three behaviours protected here:
 1. A claimed row with NULL image_url_unmasked is unrecoverable; the sweep
    must mark it error and move on (not crash, not retry forever).
 2. The SELECT-then-UPDATE race guard: when two pollers race to claim the
    same row, only one wins; the loser's _claim_next_remask returns None.
 3. _mark_done writes design_packages but NEVER trend_briefs — re-mask is
    not allowed to change upstream brief state (the brief was already
    'done' before the re-mask fired, and writing 'done' again would
    silently revert any concurrent forward-motion on the brief).
"""

from unittest.mock import MagicMock

import pytest

from packages.design.remask import (
    _claim_next_remask,
    _mark_done,
    _mark_error,
    _next_metadata_for_remask,
    run_remask_sweep,
)

# ---- Fixtures --------------------------------------------------------------


@pytest.fixture()
def db() -> MagicMock:
    """Mock Supabase client. Tests opt-in to chain shapes per assertion."""
    return MagicMock()


# ---- (1) Null image_url_unmasked path --------------------------------------


@pytest.mark.asyncio
async def test_sweep_marks_error_when_image_url_unmasked_is_null(mocker, db):
    """A re-mask row that somehow ended up with image_url_unmasked=NULL has
    no source to re-mask from. The sweep must:
      (a) call _mark_error with a clear message,
      (b) NOT proceed to call any fal client / download_image, and
      (c) continue past the bad row (loop terminates on the next None claim)."""
    # First claim returns the broken row; second returns None to terminate.
    mocker.patch(
        "packages.design.remask._claim_next_remask",
        side_effect=[
            {
                "id": "design-123",
                "trend_brief_id": "brief-456",
                "image_url_unmasked": None,
                "brief_background_removal_mode": None,
            },
            None,
        ],
    )
    mocker.patch("packages.design.remask.get_db_lazy", return_value=db)

    # Sentinels that MUST NOT be called when image_url_unmasked is null.
    bria = mocker.patch("packages.design.remask.remove_background_bria_url")
    birefnet = mocker.patch("packages.design.remask.remove_background_birefnet_url")
    local = mocker.patch("packages.design.remask.remove_background_local")
    download = mocker.patch("packages.design.remask.download_image")

    mark_error = mocker.patch("packages.design.remask._mark_error")

    await run_remask_sweep()

    mark_error.assert_called_once()
    err_args = mark_error.call_args.args
    assert err_args[1] == "design-123"
    assert "image_url_unmasked" in err_args[2]

    bria.assert_not_called()
    birefnet.assert_not_called()
    local.assert_not_called()
    download.assert_not_called()


# ---- (2) SELECT-then-UPDATE race guard -------------------------------------


def test_claim_next_remask_returns_none_when_select_finds_nothing(db):
    """No rows pending → no claim, no UPDATE attempted."""
    select_chain = MagicMock()
    select_chain.eq.return_value.eq.return_value.order.return_value.limit.return_value.execute.return_value.data = []
    db.table.return_value.select.return_value = select_chain

    result = _claim_next_remask(db)

    assert result is None
    # UPDATE must not be issued when there's nothing to claim.
    update_calls = [c for c in db.table.return_value.update.mock_calls]
    assert update_calls == []


def test_claim_next_remask_returns_none_when_update_loses_race(db):
    """SELECT found a row but a concurrent poller already claimed it between
    SELECT and UPDATE — UPDATE's WHERE status='pending' guard no-ops. The
    caller must get None (NOT the original row) so it tries the next iteration
    instead of double-processing."""
    # SELECT returns a candidate row.
    select_chain = MagicMock()
    select_chain.eq.return_value.eq.return_value.order.return_value.limit.return_value.execute.return_value.data = [
        {
            "id": "design-123",
            "trend_brief_id": "brief-456",
            "image_url_unmasked": "https://example.com/unmasked.png",
            "trend_briefs": {"background_removal_mode": "bria"},
        }
    ]
    # UPDATE returns empty data — lost the race.
    update_chain = MagicMock()
    update_chain.eq.return_value.eq.return_value.eq.return_value.execute.return_value.data = []
    db.table.return_value.select.return_value = select_chain
    db.table.return_value.update.return_value = update_chain

    result = _claim_next_remask(db)

    assert result is None, "lost-race claim must return None, not the candidate row"


# ---- (3) _mark_done isolation from trend_briefs ----------------------------


def test_mark_done_writes_design_packages_only_not_trend_briefs(db):
    """The critical Fix 2 invariant: _mark_done must touch design_packages
    but never trend_briefs. The brief was already terminal ('done') before
    the re-mask was triggered; writing 'done' again would silently revert
    any concurrent forward-motion (e.g. operator clicked Regen between when
    the re-mask was queued and when it completed)."""
    _mark_done(
        db,
        design_id="design-123",
        brief_id="brief-456",
        image_url="https://example.com/new-masked.png",
        bg_mode="bria",
    )

    tables_written = [c.args[0] for c in db.table.mock_calls if c.args]
    assert "design_packages" in tables_written
    assert "trend_briefs" not in tables_written, (
        f"_mark_done must not write trend_briefs, but did: {tables_written}"
    )


def test_mark_done_writes_correct_design_packages_fields(db):
    """Defensive: confirm the design_packages payload contains the resumed
    image_url, flips status back to needs_review, clears remask_only, and
    nulls error_message. Without this, a re-mask that recovers from a prior
    error could leave stale failure text on the row."""
    _mark_done(
        db,
        design_id="design-123",
        brief_id=None,
        image_url="https://example.com/new-masked.png",
        bg_mode="local",
    )

    update_calls = db.table.return_value.update.call_args_list
    assert update_calls, "no design_packages.update was issued"
    payload = update_calls[0].args[0]
    assert payload["status"] == "needs_review"
    assert payload["remask_only"] is False
    assert payload["image_url"] == "https://example.com/new-masked.png"
    assert payload["error_message"] is None


def test_mark_error_writes_design_packages_only(db):
    """Mirror of _mark_done's invariant for the error path. A re-mask failure
    has no business touching the brief — the original design (and brief) are
    still valid; only the re-mask attempt failed."""
    _mark_error(db, design_id="design-123", message="boom")

    tables_written = [c.args[0] for c in db.table.mock_calls if c.args]
    assert "design_packages" in tables_written
    assert "trend_briefs" not in tables_written, (
        f"_mark_error must not write trend_briefs, but did: {tables_written}"
    )


# ---- (4) _next_metadata_for_remask: stack rewrite -------------------------


def _regen(masked: str, unmasked: str | None) -> dict:
    return {
        "kind": "regen",
        "masked_url": masked,
        "unmasked_url": unmasked,
        "created_at": "2026-05-14T00:00:00+00:00",
        "prompt": "test",
        "image_model": "fal_gpt_image_2",
        "image_quality": None,
        "bg_removal_mode": "local",
    }


def test_remask_metadata_url_match_rewrites_existing_entry():
    """The common case: the operator clicked Re-mask on a stack entry whose
    unmasked_url matches the row's current image_url_unmasked. The helper
    must rewrite THAT entry's masked_url to the new one (not append a new
    entry — re-mask doesn't change the unmasked source)."""
    v0 = _regen("https://example.com/v0m.png", "https://example.com/v0u.png")
    v1 = _regen("https://example.com/v1m.png", "https://example.com/v1u.png")
    pre = {
        "image_url": "https://example.com/v1m.png",
        "image_url_unmasked": "https://example.com/v1u.png",
        "metadata": {"image_versions": [v0, v1]},
    }

    result = _next_metadata_for_remask(pre, "https://example.com/v1m-NEW.png", "bria")

    versions = result["image_versions"]
    assert len(versions) == 2, "re-mask must rewrite, not append"
    # v0 untouched
    assert versions[0]["masked_url"] == "https://example.com/v0m.png"
    # v1's masked_url replaced; unmasked_url + identifying fields preserved
    assert versions[1]["masked_url"] == "https://example.com/v1m-NEW.png"
    assert versions[1]["unmasked_url"] == "https://example.com/v1u.png"
    assert versions[1]["bg_removal_mode"] == "bria"
    assert "remasked_at" in versions[1]


def test_remask_metadata_rewrites_historical_entry_when_browsing():
    """The operator stepped back to v0 in the stack viewer, which sets the
    row's image_url_unmasked to v0's unmasked_url. Re-mask must rewrite v0
    (not v1, even though v1 is newer) — the URL match is what links the
    operator's stack selection to the row's pointer."""
    v0 = _regen("https://example.com/v0m.png", "https://example.com/v0u.png")
    v1 = _regen("https://example.com/v1m.png", "https://example.com/v1u.png")
    pre = {
        "image_url": "https://example.com/v0m.png",  # operator stepped back to v0
        "image_url_unmasked": "https://example.com/v0u.png",
        "metadata": {"image_versions": [v0, v1]},
    }

    result = _next_metadata_for_remask(pre, "https://example.com/v0m-NEW.png", "birefnet")

    versions = result["image_versions"]
    assert versions[0]["masked_url"] == "https://example.com/v0m-NEW.png"
    assert versions[1]["masked_url"] == "https://example.com/v1m.png", "v1 must not be touched"


def test_remask_metadata_legacy_row_backfills_with_new_mask():
    """A legacy row (image_url set, but no image_versions) must surface the
    re-mask result as the first stack entry so the operator's history starts
    here rather than vanishing into nothing."""
    pre = {
        "image_url": "https://example.com/legacy-m.png",
        "image_url_unmasked": "https://example.com/legacy-u.png",
        "fal_prompt": "legacy prompt",
        "metadata": {},
    }

    result = _next_metadata_for_remask(pre, "https://example.com/legacy-m-NEW.png", "local")

    versions = result["image_versions"]
    assert len(versions) == 1
    backfill = versions[0]
    assert backfill["kind"] == "regen"
    # Backfill points at the NEW mask — the prior mask is implicitly discarded
    # because the operator just chose to replace it.
    assert backfill["masked_url"] == "https://example.com/legacy-m-NEW.png"
    assert backfill["unmasked_url"] == "https://example.com/legacy-u.png"
    assert backfill["prompt"] == "legacy prompt"
    assert backfill.get("backfilled") is True
    assert backfill["bg_removal_mode"] == "local"


def test_remask_metadata_falls_back_to_last_regen_when_no_url_match():
    """Edge case: the row's image_url_unmasked doesn't match any stack
    entry's unmasked_url (e.g. a hand-edit replaced the unmasked between
    queue and execute). The helper must rewrite the most-recent regen entry
    rather than crashing or appending — degrading gracefully."""
    v0 = _regen("https://example.com/v0m.png", "https://example.com/v0u.png")
    v1 = _regen("https://example.com/v1m.png", "https://example.com/v1u.png")
    pre = {
        "image_url": "https://example.com/v1m.png",
        "image_url_unmasked": "https://example.com/some-other-unmasked.png",
        "metadata": {"image_versions": [v0, v1]},
    }

    result = _next_metadata_for_remask(pre, "https://example.com/m-NEW.png", "local")

    versions = result["image_versions"]
    assert len(versions) == 2
    assert versions[0]["masked_url"] == "https://example.com/v0m.png", "v0 untouched"
    assert versions[1]["masked_url"] == "https://example.com/m-NEW.png", "fallback to v1"


def test_remask_metadata_preserves_unrelated_metadata_keys():
    """Other keys in metadata (style_descriptors, image_model, etc. stamped
    by the processing-stub write) must survive a re-mask round-trip."""
    pre = {
        "image_url": "https://example.com/m.png",
        "image_url_unmasked": "https://example.com/u.png",
        "fal_prompt": "p",
        "metadata": {
            "style_descriptors": ["minimalist"],
            "image_model": "fal_flux_pro",
            "image_quality": None,
        },
    }

    result = _next_metadata_for_remask(pre, "https://example.com/m-NEW.png", "local")

    assert result["style_descriptors"] == ["minimalist"]
    assert result["image_model"] == "fal_flux_pro"
    assert result["image_quality"] is None
    assert "image_versions" in result

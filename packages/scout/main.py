import asyncio
import time
from typing import Any

from packages.scout.analyzer import analyze_niche
from packages.scout.dedup import is_recent_duplicate, is_semantic_duplicate
from packages.scout.etsy_client import EtsyClient
from packages.scout.seeds import NICHE_SEEDS
from packages.shared_py.db import get_db
from packages.shared_py.logger import get_logger
from packages.shared_py.notifier import notify_slack

_MAX_INSERTS = 5

# Every brief lands in the review queue and waits for owner approval before
# Builder/Design can advance it. No auto-approve bypass — every agent in the
# pipeline pauses for human review of its output.
_BRIEF_WRITE_STATUS = "needs_review"


async def run() -> None:
    log = get_logger("scout")
    db = get_db()
    etsy = EtsyClient()
    inserted = 0

    for niche in NICHE_SEEDS:
        if await is_recent_duplicate(niche, db):
            log.info(
                "dedup_skip",
                action="dedup_skip",
                niche=niche,
                match_reason="exact",
                status="skipped",
                duration_ms=0,
            )
            continue

        is_semantic_dup, matched = await is_semantic_duplicate(niche, db)
        if is_semantic_dup:
            log.info(
                "dedup_skip",
                action="dedup_skip",
                niche=niche,
                match_reason="semantic",
                matched_niche=matched,
                status="skipped",
                duration_ms=0,
            )
            continue

        t0 = time.monotonic()
        try:
            # Always fetch image URLs — cost on Etsy side is zero, and they're
            # useful in raw_etsy_data for offline analysis even when vision is
            # off. The analyzer decides whether to send them to Claude based on
            # settings.scout_vision_enabled.
            listings = await etsy.fetch_top_listings(niche, include_images=True)
            analysis = await analyze_niche(listings)

            row = {
                **analysis.model_dump(),
                "niche": niche,  # seed niche is canonical for dedup — overrides analysis.niche
                "raw_etsy_data": listings,
                "claude_analysis": analysis.model_dump(),
                "status": _BRIEF_WRITE_STATUS,
            }

            # Route through the atomic RPC (migration 033) so dedupe + insert
            # run inside a single transaction with an advisory lock on the
            # niche. The Python-side dedupes above are still useful as a
            # cheap fast-path, but they can race; the RPC is authoritative.
            # The belt UNIQUE (niche, day) index also rejects same-day
            # duplicates with PostgrestAPIError code 23505.
            def _insert() -> Any:
                return db.rpc("insert_trend_brief_if_no_recent", {"p_row": row}).execute()

            try:
                insert_resp = await asyncio.to_thread(_insert)
            except Exception as rpc_exc:
                # Belt index unique-violation lands here — treat as a
                # duplicate-after-dedupe and skip to the next niche. Any
                # other DB error propagates to the outer except.
                if "23505" in str(rpc_exc) or "duplicate key" in str(rpc_exc).lower():
                    log.info(
                        "dedup_skip",
                        action="dedup_skip",
                        niche=niche,
                        match_reason="db_unique_violation",
                        status="skipped",
                        duration_ms=round((time.monotonic() - t0) * 1000),
                    )
                    continue
                raise

            # The RPC returns the inserted row, or NULL if a recent
            # duplicate already exists. Supabase normalizes NULL to an
            # empty data list.
            rpc_data = getattr(insert_resp, "data", None)
            if not rpc_data:
                log.info(
                    "dedup_skip",
                    action="dedup_skip",
                    niche=niche,
                    match_reason="rpc_recent_duplicate",
                    status="skipped",
                    duration_ms=round((time.monotonic() - t0) * 1000),
                )
                continue

            record_id: str | None = None
            try:
                first = rpc_data[0] if isinstance(rpc_data, list) else rpc_data
                if isinstance(first, dict):
                    record_id = first.get("id")
            except (AttributeError, IndexError, KeyError, TypeError):
                record_id = None

            inserted += 1
            log.info(
                "trend_brief_created",
                action="trend_brief_created",
                niche=niche,
                record_id=record_id,
                status=_BRIEF_WRITE_STATUS,
                duration_ms=round((time.monotonic() - t0) * 1000),
            )

            if inserted >= _MAX_INSERTS:
                break

        except Exception as e:
            # Write the failure to trend_briefs so (a) it shows up in the same
            # observability surface as successful runs, and (b) is_recent_duplicate
            # suppresses the niche for 7 days — natural backoff. Without this the
            # nightly cron would re-attempt the failing niche forever and fire a
            # Slack alert each time.
            error_row = {
                "niche": niche,
                "status": "error",
                "error_message": str(e),
                "retry_count": 1,
            }

            def _insert_error() -> None:
                db.table("trend_briefs").insert(error_row).execute()

            try:
                await asyncio.to_thread(_insert_error)
            except Exception as db_exc:
                # If the error-row write itself fails, don't mask the original
                # cause — log both and continue. The alert below still fires.
                log.error(
                    "scout_error_write_failed",
                    action="scout_error_write_failed",
                    niche=niche,
                    db_error=str(db_exc),
                    original_error=str(e),
                )

            log.error(
                "scout_failure",
                action="scout_failure",
                niche=niche,
                error=str(e),
                duration_ms=round((time.monotonic() - t0) * 1000),
            )
            await notify_slack(f"Scout failed for niche '{niche}': {e}", severity="error")


if __name__ == "__main__":
    asyncio.run(run())

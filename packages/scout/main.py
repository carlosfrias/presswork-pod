import asyncio
import time

from packages.scout.analyzer import analyze_niche
from packages.scout.dedup import is_recent_duplicate, is_semantic_duplicate
from packages.scout.etsy_client import EtsyClient
from packages.scout.seeds import NICHE_SEEDS
from packages.shared_py.db import get_db
from packages.shared_py.logger import get_logger
from packages.shared_py.notifier import notify_slack

_MAX_INSERTS = 5


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
            listings = await etsy.fetch_top_listings(niche)
            analysis = await analyze_niche(listings)

            row = {
                **analysis.model_dump(),
                "niche": niche,  # seed niche is canonical for dedup — overrides analysis.niche
                "raw_etsy_data": listings,
                "claude_analysis": analysis.model_dump(),
                "status": "pending",
            }

            def _insert() -> None:
                db.table("trend_briefs").insert(row).execute()

            await asyncio.to_thread(_insert)

            inserted += 1
            log.info(
                "trend_brief_created",
                action="trend_brief_created",
                niche=niche,
                status="pending",
                duration_ms=round((time.monotonic() - t0) * 1000),
            )

            if inserted >= _MAX_INSERTS:
                break

        except Exception as e:
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

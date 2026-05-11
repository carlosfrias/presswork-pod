import asyncio
import hashlib
import time
from typing import Any, cast
from uuid import UUID, uuid4

from packages.design.constants import (
    GILDAN_64000_BLUEPRINT_ID,
    GILDAN_64000_PRINT_PROVIDER_ID,
    GILDAN_64000_VARIANT_IDS,
)
from packages.design.fal_client import generate_image
from packages.design.image_processor import process_for_print
from packages.design.poller import claim_next_brief
from packages.design.prompt_builder import build_flux_prompt
from packages.design.storage import upload_design
from packages.shared_py.db import get_db
from packages.shared_py.logger import get_logger
from packages.shared_py.notifier import notify_slack


async def run() -> None:
    log = get_logger("design")
    db = get_db()

    while True:
        brief = claim_next_brief(db)
        if brief is None:
            log.info(
                "no_pending_briefs", agent="design", action="poll", status="idle", duration_ms=0
            )
            break

        t0 = time.monotonic()
        brief_id = str(brief.id)

        existing_resp = (
            db.table("design_packages")
            .select("id,image_url,status")
            .eq("trend_brief_id", brief_id)
            .execute()
        )
        existing_row: dict[str, Any] | None = (
            cast(dict[str, Any], existing_resp.data[0]) if existing_resp.data else None
        )

        if existing_row and existing_row.get("image_url"):
            log.info(
                "design_already_done",
                agent="design",
                action="design_already_done",
                brief_id=brief_id,
                status="done",
                duration_ms=round((time.monotonic() - t0) * 1000),
            )
            db.table("trend_briefs").update({"status": "done"}).eq("id", brief_id).execute()
            continue

        # existing_row may be None (first run) or processing without image_url (retry after storage failure)
        design_id: UUID = UUID(existing_row["id"]) if existing_row else uuid4()

        try:
            flux_prompt = build_flux_prompt(brief)
            fal_prompt_hash = hashlib.sha256(flux_prompt.prompt.strip().encode()).hexdigest()

            # Cross-row dedup: if a prior design with the same prompt hash exists, reuse it
            cached_resp = (
                db.table("design_packages")
                .select("image_url,mockup_urls")
                .eq("fal_prompt_hash", fal_prompt_hash)
                .not_.is_("image_url", "null")
                .order("created_at", desc=True)
                .limit(1)
                .execute()
            )
            cached_row: dict[str, Any] | None = (
                cast(dict[str, Any], cached_resp.data[0]) if cached_resp.data else None
            )

            if cached_row:
                row_data: dict[str, Any] = {
                    "trend_brief_id": brief_id,
                    "fal_prompt": flux_prompt.prompt,
                    "fal_prompt_hash": fal_prompt_hash,
                    "printify_blueprint_id": GILDAN_64000_BLUEPRINT_ID,
                    "printify_print_provider_id": GILDAN_64000_PRINT_PROVIDER_ID,
                    "printify_variant_ids": GILDAN_64000_VARIANT_IDS,
                    "image_url": cached_row["image_url"],
                    "status": "done",
                }
                if cached_row.get("mockup_urls"):
                    row_data["mockup_urls"] = cached_row["mockup_urls"]
                if existing_row:
                    db.table("design_packages").update(row_data).eq("id", str(design_id)).execute()
                else:
                    db.table("design_packages").insert({"id": str(design_id), **row_data}).execute()
                db.table("trend_briefs").update({"status": "done"}).eq("id", brief_id).execute()
                log.info(
                    "design_cache_hit",
                    agent="design",
                    action="design_cache_hit",
                    brief_id=brief_id,
                    design_id=str(design_id),
                    fal_prompt_hash=fal_prompt_hash,
                    status="done",
                    duration_ms=round((time.monotonic() - t0) * 1000),
                )
                continue

            png_bytes = await generate_image(flux_prompt)
            # rembg + Pillow + PNG encode are all CPU-bound; offload to a worker
            # thread so the event loop and rate-limit semaphores stay responsive.
            processed = await asyncio.to_thread(process_for_print, png_bytes)

            if existing_row:
                db.table("design_packages").update(
                    {
                        "fal_prompt": flux_prompt.prompt,
                        "fal_prompt_hash": fal_prompt_hash,
                        "status": "processing",
                    }
                ).eq("id", str(design_id)).execute()
            else:
                db.table("design_packages").insert(
                    {
                        "id": str(design_id),
                        "trend_brief_id": brief_id,
                        "fal_prompt": flux_prompt.prompt,
                        "fal_prompt_hash": fal_prompt_hash,
                        "printify_blueprint_id": GILDAN_64000_BLUEPRINT_ID,
                        "printify_print_provider_id": GILDAN_64000_PRINT_PROVIDER_ID,
                        "printify_variant_ids": GILDAN_64000_VARIANT_IDS,
                        "metadata": {"style_descriptors": flux_prompt.style_descriptors},
                        "status": "processing",
                    }
                ).execute()

            image_url = upload_design(db, design_id, processed)

            db.table("design_packages").update(
                {
                    "image_url": image_url,
                    "status": "done",
                }
            ).eq("id", str(design_id)).execute()

            db.table("trend_briefs").update({"status": "done"}).eq("id", brief_id).execute()

            log.info(
                "design_package_created",
                agent="design",
                action="design_package_created",
                brief_id=brief_id,
                design_id=str(design_id),
                status="done",
                duration_ms=round((time.monotonic() - t0) * 1000),
            )

        except Exception as e:
            # Retry counter lives on design_packages (not trend_briefs — trend_briefs.retry_count
            # belongs to the Scout). Read what's there, increment, and write the new error
            # state. If the row doesn't exist yet (exception fired before the insert) we
            # upsert a stub so the next retry can read its retry_count.
            current_resp = (
                db.table("design_packages").select("retry_count").eq("id", str(design_id)).execute()
            )
            current_retry = (
                cast(dict[str, Any], current_resp.data[0])["retry_count"]
                if current_resp.data
                else 0
            )
            new_retry = current_retry + 1

            design_error_row = {
                "id": str(design_id),
                "trend_brief_id": brief_id,
                "status": "error",
                "error_message": str(e),
                "retry_count": new_retry,
            }
            db.table("design_packages").upsert(design_error_row).execute()

            if new_retry < 3:
                # Revert trend_briefs to 'pending' so the design poller re-claims it.
                # Do NOT increment trend_briefs.retry_count (that's the Scout's counter)
                # and do NOT pass through 'error' first — the design's own retry budget
                # is tracked on design_packages above.
                db.table("trend_briefs").update({"status": "pending"}).eq("id", brief_id).execute()
            else:
                # Terminal: leave trend_briefs at 'error' too so observability is clean
                # and the design poller doesn't keep churning.
                db.table("trend_briefs").update(
                    {
                        "status": "error",
                        "error_message": str(e),
                    }
                ).eq("id", brief_id).execute()
                await notify_slack(
                    f"Design hit retry ceiling for trend_brief={brief_id}: {e}",
                    severity="error",
                )

            log.error(
                "design_failure",
                agent="design",
                action="design_failure",
                brief_id=brief_id,
                status="error",
                error=str(e),
                duration_ms=round((time.monotonic() - t0) * 1000),
            )


if __name__ == "__main__":
    asyncio.run(run())

"""Cheap-regen path: re-run background removal on an existing design without
re-paying for image gen + Claude + upscaler.

Triggered by the dashboard's "Re-mask only" button, which sets
design_packages.remask_only=true and status='pending' on a specific row.
This sweep claims those rows (a separate queue from the regular brief
claim), runs only:
    1. Fetch existing image_url_unmasked from Supabase storage
    2. fal background removal (BiRefNet or Bria, per brief override or flag)
    3. Pillow resize/pad to print canvas
    4. Upload new masked image to Supabase storage
    5. Reset remask_only=false, status='needs_review'

Cost: ~$0.02 per re-mask vs ~$0.10–0.30 for a full regen.

The sweep runs before the regular brief-claim loop in main.py so cheap work
drains first when the operator clicks Run Design.
"""

from __future__ import annotations

import asyncio
import time
from datetime import UTC, datetime
from typing import Any, cast

from packages.design.birefnet import remove_background_birefnet_url
from packages.design.bria import remove_background_bria_url
from packages.design.image_processor import process_for_print
from packages.design.local_bg_removal import remove_background_local
from packages.design.storage import upload_design
from packages.shared_py.config import get_settings
from packages.shared_py.fal_http import download_image
from packages.shared_py.llm_usage import FAL_COST_USD
from packages.shared_py.logger import get_logger
from packages.shared_py.runtime_flags import get_runtime_flag
from supabase import Client

# Match the cap in main.py — remask backfills the existing pair on legacy
# rows with no version history yet, so the cap can fire here too.
_IMAGE_VERSIONS_CAP = 8


async def run_remask_sweep() -> None:
    """Drain all pending re-mask requests. Returns when the queue is empty.

    Each row is processed in isolation — a failure on one row marks that row
    'error' and the sweep moves on. We deliberately don't batch with the
    regular brief loop so a re-mask failure can't block fresh briefs and
    vice versa.
    """
    log = get_logger("design")
    db = get_db_lazy()

    while True:
        row = await asyncio.to_thread(_claim_next_remask, db)
        if row is None:
            return

        design_id = row["id"]
        brief_id = row.get("trend_brief_id")
        unmasked_url = row.get("image_url_unmasked")
        t0 = time.monotonic()

        # Guard: a re-mask request without a stored unmasked image is
        # unrecoverable here — we have nothing to start from. Surface a
        # clear error rather than silently no-op.
        if not unmasked_url:
            await asyncio.to_thread(
                _mark_error,
                db,
                design_id,
                "remask: image_url_unmasked is null — cannot re-mask without a source image.",
            )
            log.warning(
                "remask_no_unmasked",
                agent="design",
                action="remask",
                design_id=design_id,
                brief_id=brief_id,
                status="error",
                duration_ms=round((time.monotonic() - t0) * 1000),
            )
            continue

        # Resolve bg-removal mode the same way the full pipeline does:
        # brief column > runtime flag > env setting.
        settings = get_settings()
        brief_mode = row.get("brief_background_removal_mode")
        bg_mode = brief_mode or get_runtime_flag(
            "background_removal_mode", settings.background_removal_mode
        )

        try:
            # Step 1: bg removal. Three modes; local skips the fal round-trip.
            if bg_mode == "local":
                unmasked_bytes = await download_image(unmasked_url)
                masked_bytes = await remove_background_local(unmasked_bytes)
            else:
                if bg_mode == "bria":
                    masked_url = await remove_background_bria_url(unmasked_url)
                else:
                    masked_url = await remove_background_birefnet_url(unmasked_url)
                masked_bytes = await download_image(masked_url)

            # Step 2: Pillow resize/pad to print canvas.
            processed = await asyncio.to_thread(process_for_print, masked_bytes)

            # Step 3: upload to Supabase. Versioned key so the previous
            # masked PNG (referenced by older stack entries) isn't trampled.
            # image_url_unmasked is intentionally left intact — the same
            # unmasked source is reused for any FUTURE re-masks on the same
            # row, and historical stack entries still point at it.
            image_url = await asyncio.to_thread(
                upload_design, db, design_id, processed, versioned=True
            )

            await asyncio.to_thread(_mark_done, db, design_id, brief_id, image_url, bg_mode)
            log.info(
                "remask_done",
                agent="design",
                action="remask",
                design_id=design_id,
                brief_id=brief_id,
                bg_mode=bg_mode,
                status="done",
                duration_ms=round((time.monotonic() - t0) * 1000),
            )
        except Exception as err:  # noqa: BLE001 — per-row isolation
            await asyncio.to_thread(_mark_error, db, design_id, f"remask: {err}")
            log.exception(
                "remask_failed",
                agent="design",
                action="remask",
                design_id=design_id,
                brief_id=brief_id,
                bg_mode=bg_mode,
                status="error",
                duration_ms=round((time.monotonic() - t0) * 1000),
            )


def get_db_lazy() -> Client:
    """Indirection so the import-time DB client init doesn't run when
    main.py imports this module (matches the main.py pattern)."""
    from packages.shared_py.db import get_db

    return get_db()


def _claim_next_remask(db: Client) -> dict[str, Any] | None:
    """Atomically claim one re-mask-pending row.

    Uses an UPDATE … SET status='processing' WHERE status='pending' AND
    remask_only=true RETURNING * pattern so two concurrent pollers can't
    both grab the same row. supabase-py doesn't expose RETURNING directly;
    we do a SELECT-then-UPDATE with status='pending' as the WHERE guard —
    if another claimant beat us between the select and the update, the
    UPDATE no-ops and we just try the next iteration.

    The joined brief_background_removal_mode column is hoisted onto the
    returned dict so the caller doesn't need a second query.
    """
    resp = (
        db.table("design_packages")
        .select("id,trend_brief_id,image_url_unmasked,trend_briefs!inner(background_removal_mode)")
        .eq("remask_only", True)
        .eq("status", "pending")
        .order("created_at")
        .limit(1)
        .execute()
    )
    if not resp.data:
        return None

    row = cast(dict[str, Any], resp.data[0])
    design_id = row["id"]

    update_resp = (
        db.table("design_packages")
        .update({"status": "processing"})
        .eq("id", design_id)
        .eq("status", "pending")
        .eq("remask_only", True)
        .execute()
    )
    if not update_resp.data:
        # Lost the race; let the outer loop pick the next one up.
        return None

    brief_join = row.get("trend_briefs") or {}
    return {
        "id": design_id,
        "trend_brief_id": row.get("trend_brief_id"),
        "image_url_unmasked": row.get("image_url_unmasked"),
        "brief_background_removal_mode": brief_join.get("background_removal_mode"),
    }


def _remask_cost(bg_mode: str) -> float:
    """Estimate the fal.ai cost for a re-mask (bg removal only, no image gen)."""
    if bg_mode == "birefnet":
        return FAL_COST_USD.get("fal-ai/birefnet/v2", 0.02)
    if bg_mode == "bria":
        return FAL_COST_USD.get("fal-ai/bria/background/remove", 0.018)
    return 0.0  # local: free


def _mark_done(
    db: Client,
    design_id: str,
    brief_id: str | None,
    image_url: str,
    bg_mode: str,
) -> None:
    """Finalize the re-mask: flip status back to needs_review, clear the
    remask_only flag, record the new image_url, and rewrite the matching
    stack entry's masked_url so step-back-to-here keeps showing the
    operator's latest mask of that unmasked iteration.

    Brief stays where it was — a re-mask doesn't change the upstream
    brief's state. brief_id is accepted for logging only.
    """
    # Read-modify-write metadata so the stack stays coherent with image_url.
    # The dashboard's remask action set image_url_unmasked to the operator's
    # selected stack entry's unmasked_url before triggering this sweep, so
    # matching by URL identifies the right entry to rewrite.
    pre_resp = (
        db.table("design_packages")
        .select("image_url,image_url_unmasked,fal_prompt,metadata,generation_cost_usd")
        .eq("id", design_id)
        .execute()
    )
    pre = cast(dict[str, Any], pre_resp.data[0]) if pre_resp.data else {}
    next_meta = _next_metadata_for_remask(pre, image_url, bg_mode)

    prior_cost = float(pre.get("generation_cost_usd") or 0)
    remask_cost = _remask_cost(bg_mode)

    db.table("design_packages").update(
        {
            "status": "needs_review",
            "remask_only": False,
            "image_url": image_url,
            "metadata": next_meta,
            "error_message": None,
            "generation_cost_usd": round(prior_cost + remask_cost, 4),
        }
    ).eq("id", design_id).execute()


def _next_metadata_for_remask(
    pre_row: dict[str, Any],
    new_masked_url: str,
    bg_mode: str,
) -> dict[str, Any]:
    """Compute the next metadata blob after a re-mask completes.

    Resolution order:
    - Empty stack + row already has an image pair → backfill the prior pair
      as a synthetic regen entry, then rewrite ITS masked_url to the new
      one (re-mask doesn't add a fresh entry — only changes the mask of
      the current unmasked).
    - Stack has entries → find the entry whose unmasked_url matches the
      row's current image_url_unmasked and rewrite its masked_url. Fall
      back to the last entry if no match (e.g. legacy state).
    - No match anywhere → append a fresh regen entry as a last resort so
      the new masked URL is at least represented in the stack.
    """
    meta_in = pre_row.get("metadata") if isinstance(pre_row.get("metadata"), dict) else {}
    meta_in = meta_in or {}
    raw_versions = meta_in.get("image_versions") if isinstance(meta_in, dict) else None
    versions: list[dict[str, Any]] = (
        [v for v in raw_versions if isinstance(v, dict)] if isinstance(raw_versions, list) else []
    )
    current_unmasked = pre_row.get("image_url_unmasked")
    current_masked = pre_row.get("image_url")
    has_regen_history = any(v.get("kind") == "regen" for v in versions)

    if not has_regen_history and current_masked:
        # Legacy row — backfill the existing pair, then immediately overlay
        # the new mask onto it so the stack reflects the re-mask.
        versions.append(
            {
                "kind": "regen",
                "masked_url": new_masked_url,
                "unmasked_url": current_unmasked,
                "created_at": datetime.now(tz=UTC).isoformat(),
                "prompt": pre_row.get("fal_prompt"),
                "image_model": None,
                "image_quality": None,
                "bg_removal_mode": bg_mode,
                "backfilled": True,
            }
        )
    else:
        # Find the entry whose unmasked matches the row's current unmasked.
        # Iterate newest-last; pick the LAST match so a re-mask after a stack
        # navigation hits the most-recently-active entry rather than the oldest.
        target_idx = None
        for i in range(len(versions) - 1, -1, -1):
            if (
                versions[i].get("kind") == "regen"
                and versions[i].get("unmasked_url") == current_unmasked
            ):
                target_idx = i
                break
        if target_idx is None and versions:
            # No URL match — fall back to the most recent regen entry. Edge
            # case: the operator's stack selection was clobbered by a
            # concurrent write, or the unmasked URL was changed by a hand-edit.
            for i in range(len(versions) - 1, -1, -1):
                if versions[i].get("kind") == "regen":
                    target_idx = i
                    break

        if target_idx is None:
            # Stack has no regen entries at all — append a fresh one so the
            # re-mask is at least represented. This shouldn't normally fire.
            versions.append(
                {
                    "kind": "regen",
                    "masked_url": new_masked_url,
                    "unmasked_url": current_unmasked,
                    "created_at": datetime.now(tz=UTC).isoformat(),
                    "prompt": pre_row.get("fal_prompt"),
                    "image_model": None,
                    "image_quality": None,
                    "bg_removal_mode": bg_mode,
                }
            )
        else:
            existing = dict(versions[target_idx])
            existing["masked_url"] = new_masked_url
            existing["bg_removal_mode"] = bg_mode
            existing["remasked_at"] = datetime.now(tz=UTC).isoformat()
            versions[target_idx] = existing

    if len(versions) > _IMAGE_VERSIONS_CAP:
        versions = versions[-_IMAGE_VERSIONS_CAP:]

    return {**meta_in, "image_versions": versions}


def _mark_error(db: Client, design_id: str, message: str) -> None:
    db.table("design_packages").update(
        {
            "status": "error",
            "remask_only": False,
            "error_message": message[:500],
        }
    ).eq("id", design_id).execute()

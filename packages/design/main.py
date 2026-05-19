import asyncio
import hashlib
import time
from datetime import UTC, datetime
from typing import Any, cast
from uuid import UUID, uuid4

from packages.design.birefnet import remove_background_birefnet_url
from packages.design.bria import remove_background_bria_url
from packages.design.constants import (
    GILDAN_64000_BLUEPRINT_ID,
    GILDAN_64000_PRINT_PROVIDER_ID,
    GILDAN_64000_VARIANT_IDS,
)
from packages.design.fal_client import generate_image_url as generate_flux_image_url
from packages.design.gpt_image_client import (
    generate_image_url as generate_gpt_image_url,
)
from packages.design.image_processor import process_for_print
from packages.design.local_bg_removal import remove_background_local
from packages.design.nano_banana_client import (
    generate_image_url as generate_nano_banana_image_url,
)
from packages.design.poller import claim_next_brief
from packages.design.prompt_builder import build_image_prompt
from packages.design.remask import run_remask_sweep
from packages.design.storage import upload_design
from packages.design.upscaler import upscale_url
from packages.shared_py.config import get_settings
from packages.shared_py.db import get_db
from packages.shared_py.fal_http import download_image
from packages.shared_py.llm_usage import (
    FAL_COST_USD,
    GPT_IMAGE_COST_USD,
    NANO_BANANA_COST_USD,
    record_usage,
)
from packages.shared_py.logger import get_logger
from packages.shared_py.notifier import notify_slack
from packages.shared_py.runtime_flags import get_runtime_flag

# Every finished design pauses at needs_review so the owner can approve, regen,
# or reject before Listing publishes. No auto-approve bypass — every agent in
# the pipeline pauses for human review of its output.
_DESIGN_OUTPUT_STATUS = "needs_review"

# Cap on history depth in design_packages.metadata.image_versions. The stack
# is a UI affordance for stepping back through recent regens, not an audit
# log; bound the JSONB blob so a long-lived design row can't accumulate
# unbounded metadata. Older entries fall off the front; their storage objects
# are NOT cleaned up here (slow leak, accepted — full regen is ~$0.10–0.30
# while storage is cents per GB). A future cleanup cron can sweep.
_IMAGE_VERSIONS_CAP = 8


def _next_image_versions(
    pre_row: dict[str, Any], new_entry: dict[str, Any]
) -> list[dict[str, Any]]:
    """Compute the next metadata.image_versions array after a successful run.

    Backfills the row's CURRENT (about-to-be-overwritten) image pair as a
    synthetic stack entry the first time we touch a row that has no version
    history yet. This makes the operator's previous masked/unmasked pair
    visible in the stack viewer alongside the new entry, instead of vanishing
    silently on the next regen.

    Caps the result at _IMAGE_VERSIONS_CAP entries (newest-last) so the
    JSONB blob can't grow without bound.
    """
    meta_in = pre_row.get("metadata") if isinstance(pre_row.get("metadata"), dict) else {}
    existing_versions = []
    if isinstance(meta_in, dict):
        raw = meta_in.get("image_versions")
        if isinstance(raw, list):
            existing_versions = [v for v in raw if isinstance(v, dict)]

    next_versions = list(existing_versions)

    # Backfill the row's current pair as a synthetic prior entry IF we've
    # never recorded any history. We discriminate against `regen` entries
    # specifically — hand-edit history (kind: "ai_original" / "hand_edit")
    # is unrelated and shouldn't suppress a backfill.
    has_regen_history = any(v.get("kind") == "regen" for v in next_versions)
    current_masked = pre_row.get("image_url")
    if not has_regen_history and current_masked:
        next_versions.append(
            {
                "kind": "regen",
                "masked_url": current_masked,
                "unmasked_url": pre_row.get("image_url_unmasked"),
                # No precise timestamp available for the backfill — best-effort.
                "created_at": datetime.now(tz=UTC).isoformat(),
                "prompt": pre_row.get("fal_prompt"),
                "image_model": None,
                "image_quality": None,
                "bg_removal_mode": None,
                "backfilled": True,
            }
        )

    next_versions.append(new_entry)

    if len(next_versions) > _IMAGE_VERSIONS_CAP:
        next_versions = next_versions[-_IMAGE_VERSIONS_CAP:]

    return next_versions


def _estimate_run_cost(
    image_model: str,
    image_quality: str | None,
    upscaler_ran: bool,
    bg_mode: str,
) -> float:
    """Estimate the fal.ai USD cost for one Design agent run.

    Uses the same price table as record_usage so the per-design tally stays
    consistent with the aggregate SpendPanel. Costs are estimates off fal's
    published pricing — the authoritative number is the fal balance delta.
    """
    cost = 0.0
    if image_model == "fal_flux_pro":
        cost += FAL_COST_USD.get("fal-ai/flux-pro/v1.1", 0.05)
    elif image_model == "fal_gpt_image_2":
        cost += GPT_IMAGE_COST_USD.get(image_quality or "low", 0.012)
    elif image_model == "fal_nano_banana_2":
        cost += NANO_BANANA_COST_USD.get(image_quality or "low", 0.06)
    if upscaler_ran:
        cost += FAL_COST_USD.get("fal-ai/aura-sr", 0.01)
    if bg_mode == "birefnet":
        cost += FAL_COST_USD.get("fal-ai/birefnet/v2", 0.02)
    elif bg_mode == "bria":
        cost += FAL_COST_USD.get("fal-ai/bria/background/remove", 0.018)
    # local bg removal: $0
    return round(cost, 4)


async def run() -> None:
    log = get_logger("design")
    db = get_db()

    # Drain pending re-mask requests FIRST — these are cheap (~$0.02 each
    # vs ~$0.10–0.30 for a full regen) and the operator triggered them
    # explicitly from the review card. Process them before any new briefs
    # so the operator's surgical fix lands fast, not behind a queue of
    # full-pipeline jobs.
    await run_remask_sweep()

    while True:
        brief = await asyncio.to_thread(claim_next_brief, db)
        if brief is None:
            log.info(
                "no_pending_briefs", agent="design", action="poll", status="idle", duration_ms=0
            )
            break

        t0 = time.monotonic()
        brief_id = str(brief.id)

        def _select_existing() -> Any:
            return (
                db.table("design_packages")
                .select("id,image_url,status")
                .eq("trend_brief_id", brief_id)
                .execute()
            )

        existing_resp = await asyncio.to_thread(_select_existing)
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
            # Resume-from-crash guard: if a prior run uploaded the image but
            # crashed before _write_done flipped status, the row is stranded
            # at 'processing' (or 'error' if the handler partially ran). The
            # design itself is fine — the URL is on the row — so lift the
            # design_packages row to its terminal status and clear any stale
            # error_message. Listing polls for 'approved' (via 'needs_review')
            # so without this step the design would be permanently orphaned.
            existing_status = existing_row.get("status")
            if existing_status in ("processing", "error"):
                existing_id = existing_row["id"]
                await asyncio.to_thread(
                    lambda: (
                        db.table("design_packages")
                        .update(
                            {
                                "status": _DESIGN_OUTPUT_STATUS,
                                "error_message": None,
                            }
                        )
                        .eq("id", existing_id)
                        .execute()
                    )
                )
            await asyncio.to_thread(
                lambda: (
                    db.table("trend_briefs").update({"status": "done"}).eq("id", brief_id).execute()
                )
            )
            continue

        # existing_row may be None (first run) or processing without image_url (retry after storage failure)
        design_id: UUID = UUID(existing_row["id"]) if existing_row else uuid4()

        try:
            # Returns FluxPrompt for fal_flux_pro briefs, ImagePrompt for
            # fal_gpt_image_2 briefs — both have `.prompt` and
            # `.style_descriptors`. Native async via AsyncAnthropic (the
            # builders no longer block the event loop, so no asyncio.to_thread).
            image_prompt = await build_image_prompt(brief)
            # Hash includes image_model AND the effective bg-removal mode so
            # otherwise-identical prompts don't collide in the cross-row
            # dedup cache. Without bg_mode in the hash, changing the chip
            # and clicking full Regen would cache-hit the OLD masked image
            # and silently undo the operator's bg-mode swap.
            settings = get_settings()
            effective_bg_mode = brief.background_removal_mode or get_runtime_flag(
                "background_removal_mode", settings.background_removal_mode
            )
            fal_prompt_hash = hashlib.sha256(
                f"{brief.image_model}:{effective_bg_mode}:{image_prompt.prompt.strip()}".encode()
            ).hexdigest()

            # Cross-row dedup: if a prior design with the same prompt hash exists, reuse it
            def _select_cached() -> Any:
                return (
                    db.table("design_packages")
                    .select("image_url,image_url_unmasked,mockup_urls")
                    .eq("fal_prompt_hash", fal_prompt_hash)
                    .not_.is_("image_url", "null")
                    .order("created_at", desc=True)
                    .limit(1)
                    .execute()
                )

            cached_resp = await asyncio.to_thread(_select_cached)
            cached_row: dict[str, Any] | None = (
                cast(dict[str, Any], cached_resp.data[0]) if cached_resp.data else None
            )

            if cached_row:
                row_data: dict[str, Any] = {
                    "trend_brief_id": brief_id,
                    "fal_prompt": image_prompt.prompt,
                    "fal_prompt_hash": fal_prompt_hash,
                    "printify_blueprint_id": GILDAN_64000_BLUEPRINT_ID,
                    "printify_print_provider_id": GILDAN_64000_PRINT_PROVIDER_ID,
                    "printify_variant_ids": GILDAN_64000_VARIANT_IDS,
                    "image_url": cached_row["image_url"],
                    "image_url_unmasked": cached_row.get("image_url_unmasked"),
                    "status": _DESIGN_OUTPUT_STATUS,
                }
                if cached_row.get("mockup_urls"):
                    row_data["mockup_urls"] = cached_row["mockup_urls"]

                def _write_cache_hit() -> None:
                    if existing_row:
                        db.table("design_packages").update(row_data).eq(
                            "id", str(design_id)
                        ).execute()
                    else:
                        db.table("design_packages").insert(
                            {"id": str(design_id), **row_data}
                        ).execute()
                    db.table("trend_briefs").update({"status": "done"}).eq("id", brief_id).execute()

                await asyncio.to_thread(_write_cache_hit)
                # Stamp a zero-cost llm_usage row so the Design SpendPanel's
                # "Cache hits" counter has something to count. provider="fal"
                # keeps it inside the existing dashboard query window; the
                # operation prefix doesn't match flux/aura/birefnet so it
                # doesn't get bucketed into any spend total. The cache_hit
                # flag in metadata is the signal getDesignSpend reads.
                await asyncio.to_thread(
                    record_usage,
                    agent="design",
                    provider="fal",
                    operation="design_cache_hit",
                    cost_usd=0.0,
                    metadata={
                        "cache_hit": True,
                        "brief_id": brief_id,
                        "fal_prompt_hash": fal_prompt_hash,
                    },
                )
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

            # Hoist before the closure so pyright keeps the non-None narrowing
            # (brief is TrendBrief | None at the function scope; inside a nested
            # def pyright can no longer track the outer None-guard).
            _brief_image_model = brief.image_model
            _brief_image_quality = brief.image_quality

            # Heartbeat write: record that this row is being worked on BEFORE
            # we kick off the expensive fal pipeline. Without this, the only
            # observability for a brief mid-flight is a concurrent poller's
            # claim — and if the row never gets created (an exception during
            # any fal stage) the error handler below is the first writer.
            # Writing here also creates the design_packages row early, so an
            # operator inspecting Supabase mid-run sees status='processing'.
            def _write_processing_stub() -> None:
                if existing_row:
                    db.table("design_packages").update(
                        {
                            "fal_prompt": image_prompt.prompt,
                            "fal_prompt_hash": fal_prompt_hash,
                            "status": "processing",
                        }
                    ).eq("id", str(design_id)).execute()
                else:
                    db.table("design_packages").insert(
                        {
                            "id": str(design_id),
                            "trend_brief_id": brief_id,
                            "fal_prompt": image_prompt.prompt,
                            "fal_prompt_hash": fal_prompt_hash,
                            "printify_blueprint_id": GILDAN_64000_BLUEPRINT_ID,
                            "printify_print_provider_id": GILDAN_64000_PRINT_PROVIDER_ID,
                            "printify_variant_ids": GILDAN_64000_VARIANT_IDS,
                            "metadata": {
                                "style_descriptors": image_prompt.style_descriptors,
                                "image_model": _brief_image_model,
                                "image_quality": _brief_image_quality,
                            },
                            "status": "processing",
                        }
                    ).execute()

            await asyncio.to_thread(_write_processing_stub)

            # URL-threading pipeline: every fal stage runs on a fal-hosted URL,
            # so the bytes never leave fal's network until the very end. The
            # previous bytes-in/bytes-out design re-downloaded + re-uploaded
            # ~22 MB per design needlessly. We now download exactly once,
            # after the last fal call, when Pillow actually needs the pixels.
            #
            # Backend dispatch:
            #   FLUX           → legacy small-output path; needs aura-sr upscaler.
            #   gpt-image-2    → 2560×3072 native, large enough to skip upscaler.
            #   nano-banana-2  → 1K–2K native (resolution from image_quality tier),
            #                    skips upscaler. Output is opaque; downstream
            #                    background-removal pass handles the transparent
            #                    PNG conversion exactly as for the other backends.
            if brief.image_model == "fal_flux_pro":
                # FluxPrompt path — validated, with negative_prompt + ritual phrases.
                work_url = await generate_flux_image_url(image_prompt)  # type: ignore[arg-type]
            elif brief.image_model == "fal_nano_banana_2":
                # Natural-English prompt; resolution comes from image_quality.
                work_url = await generate_nano_banana_image_url(
                    image_prompt,  # type: ignore[arg-type]
                    quality=brief.image_quality,
                )
            else:
                # gpt-image-2 path — natural-English prompt, no negative_prompt.
                work_url = await generate_gpt_image_url(
                    image_prompt,  # type: ignore[arg-type]
                    quality=brief.image_quality,
                )

            # AI upscale (aura-sr 4×) — only for FLUX. gpt-image-2 outputs at
            # 2560×3072 natively, large enough that Pillow's resize to 4500×5400
            # is a ~1.76× upscale handled cleanly without a fal-side pass.
            # Soft-fail to the un-upscaled URL so a flaky fal endpoint doesn't
            # consume the 3-retry budget. runtime_flags can flip the env default
            # off without a redeploy.
            upscaler_ran = False
            upscaler_on = get_runtime_flag("upscaler_enabled", get_settings().upscaler_enabled)
            if brief.image_model == "fal_flux_pro" and upscaler_on:
                try:
                    work_url = await upscale_url(work_url)
                    upscaler_ran = True
                except Exception as upscale_err:
                    log.warning(
                        "upscaler_failed_fallback",
                        agent="design",
                        action="upscale",
                        brief_id=brief_id,
                        design_id=str(design_id),
                        error=str(upscale_err),
                    )
                    await notify_slack(
                        f"Upscaler failed for brief {brief_id}, falling back to LANCZOS: {upscale_err}",
                        severity="warn",
                    )

            # Snapshot the URL going INTO background removal so we can later
            # download the pre-mask preview for the Design page's mask-QA flip.
            pre_mask_url = work_url

            # Background removal — three modes. Precedence:
            #   1. brief.background_removal_mode — per-brief operator override
            #      set from the Design review-card picker on Regen.
            #   2. runtime_flags.background_removal_mode — global default
            #      (currently "local" — see migration 042).
            #   3. settings.background_removal_mode — env-var fallback.
            # The two fal modes (birefnet v2 + bria 2.0) are URL-in/URL-out:
            # work_url is threaded through the fal call, then both the masked
            # output and the pre-mask preview are downloaded in parallel.
            # The local mode (rembg U²-Net in-process) is bytes-in/bytes-out:
            # we download pre_mask_url ONCE and reuse those bytes for both
            # outputs — no fal call, no second download. Per user constraint
            # ("don't upload the file to fal"), local never re-uploads.
            # On failure the design lands in 'error' and retries through the
            # normal 3-strike budget.
            settings = get_settings()
            bg_mode = brief.background_removal_mode or get_runtime_flag(
                "background_removal_mode", settings.background_removal_mode
            )
            if bg_mode == "local":
                pre_mask_bytes = await download_image(pre_mask_url)
                png_bytes = await remove_background_local(pre_mask_bytes)
            else:
                if bg_mode == "bria":
                    work_url = await remove_background_bria_url(work_url)
                else:
                    work_url = await remove_background_birefnet_url(work_url)
                png_bytes, pre_mask_bytes = await asyncio.gather(
                    download_image(work_url),
                    download_image(pre_mask_url),
                )

            # Pillow + PNG encode are CPU-bound; offload to a worker thread so
            # the event loop stays responsive.
            processed = await asyncio.to_thread(process_for_print, png_bytes)

            # Pre-mask preview: same resize/pad, sourced from the original
            # fal-generated image so the operator can verify the cutout cut
            # cleanly.
            processed_unmasked = await asyncio.to_thread(process_for_print, pre_mask_bytes)

            # Versioned uploads — every regen lands at a fresh storage key so
            # the stack of historical iterations stored in
            # design_packages.metadata.image_versions points at immutable
            # objects. The re-mask sweep intentionally overwrites the
            # constant-key path; full regens (this path) never do.
            image_url, image_url_unmasked = await asyncio.gather(
                asyncio.to_thread(upload_design, db, design_id, processed, versioned=True),
                asyncio.to_thread(
                    upload_design,
                    db,
                    design_id,
                    processed_unmasked,
                    suffix="-unmasked",
                    versioned=True,
                ),
            )

            run_cost = _estimate_run_cost(
                image_model=brief.image_model,
                image_quality=brief.image_quality,
                upscaler_ran=upscaler_ran,
                bg_mode=bg_mode,
            )

            new_entry = {
                "kind": "regen",
                "masked_url": image_url,
                "unmasked_url": image_url_unmasked,
                "created_at": datetime.now(tz=UTC).isoformat(),
                "prompt": image_prompt.prompt,
                "image_model": brief.image_model,
                "image_quality": brief.image_quality,
                "bg_removal_mode": bg_mode,
                "cost_usd": run_cost,
            }

            def _write_done() -> None:
                # Read current row state to compute the next image_versions
                # array and add this run's cost to the running total.
                # Read-modify-write is safe here: a single design row is owned
                # by exactly one Design run at a time (claim RPC prevents
                # concurrent claimers on the same brief).
                pre_resp = (
                    db.table("design_packages")
                    .select("image_url,image_url_unmasked,fal_prompt,metadata,generation_cost_usd")
                    .eq("id", str(design_id))
                    .execute()
                )
                pre = cast(dict[str, Any], pre_resp.data[0]) if pre_resp.data else {}
                versions = _next_image_versions(pre, new_entry)

                meta_in = pre.get("metadata") if isinstance(pre.get("metadata"), dict) else {}
                next_meta = {**(meta_in or {}), "image_versions": versions}

                prior_cost = float(pre.get("generation_cost_usd") or 0)

                db.table("design_packages").update(
                    {
                        "image_url": image_url,
                        "image_url_unmasked": image_url_unmasked,
                        "metadata": next_meta,
                        "generation_cost_usd": round(prior_cost + run_cost, 4),
                        "status": _DESIGN_OUTPUT_STATUS,
                    }
                ).eq("id", str(design_id)).execute()
                db.table("trend_briefs").update({"status": "done"}).eq("id", brief_id).execute()

            await asyncio.to_thread(_write_done)

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
            # `e` is deleted at the end of the `except` block, so any lambda that
            # captures it would fail with NameError. Snapshot to a local first.
            err_msg = str(e)

            # The error handler used to perform two unguarded secondary DB
            # calls (select retry_count + upsert design_packages) before the
            # trend_briefs status flip and Slack alert. A transient DB
            # timeout on either of those left the brief stuck in 'processing'
            # forever (AUDIT_4 H7). Each secondary write now lives inside
            # its own try/except so the alert always fires.

            new_retry = 0
            try:
                # Retry counter lives on design_packages (not trend_briefs —
                # trend_briefs.retry_count belongs to Scout). Read what's
                # there, increment, and write the new error state. If the
                # row doesn't exist yet (exception fired before the insert)
                # we upsert a stub so the next retry can read its retry_count.
                def _select_retry_count() -> Any:
                    return (
                        db.table("design_packages")
                        .select("retry_count")
                        .eq("id", str(design_id))
                        .execute()
                    )

                current_resp = await asyncio.to_thread(_select_retry_count)
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
                    "error_message": err_msg,
                    "retry_count": new_retry,
                }
                await asyncio.to_thread(
                    lambda: db.table("design_packages").upsert(design_error_row).execute()
                )
            except Exception as inner:
                log.error(
                    "design_error_handler_db_failed",
                    agent="design",
                    action="design_error_handler_db_failed",
                    brief_id=brief_id,
                    design_id=str(design_id),
                    db_error=str(inner),
                    original_error=err_msg,
                )

            # Any design failure is terminal: park trend_briefs at 'error' with the
            # message, alert Slack, and stop. No auto-retry, no revert to 'pending'.
            # Once a brief has been approved, the only way it leaves 'approved' →
            # 'processing' → 'done' is forward; failures require operator inspection
            # (re-approve the brief in the dashboard to retry). Do NOT touch
            # trend_briefs.retry_count — that counter belongs to Scout.
            try:
                await asyncio.to_thread(
                    lambda: (
                        db.table("trend_briefs")
                        .update(
                            {
                                "status": "error",
                                "error_message": err_msg,
                            }
                        )
                        .eq("id", brief_id)
                        .execute()
                    )
                )
            except Exception as inner:
                log.error(
                    "design_error_handler_brief_update_failed",
                    agent="design",
                    action="design_error_handler_brief_update_failed",
                    brief_id=brief_id,
                    db_error=str(inner),
                    original_error=err_msg,
                )

            # Alert always fires regardless of the secondary DB outcomes
            # above. notify_slack itself swallows its own errors.
            await notify_slack(
                f"Design failed for trend_brief={brief_id} "
                f"(design_packages.retry_count={new_retry}): {err_msg}",
                severity="error",
            )

            log.error(
                "design_failure",
                agent="design",
                action="design_failure",
                brief_id=brief_id,
                status="error",
                error=err_msg,
                duration_ms=round((time.monotonic() - t0) * 1000),
            )


if __name__ == "__main__":
    asyncio.run(run())

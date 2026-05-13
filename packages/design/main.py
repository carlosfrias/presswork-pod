import asyncio
import hashlib
import time
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
from packages.design.poller import claim_next_brief
from packages.design.prompt_builder import build_image_prompt
from packages.design.storage import upload_design
from packages.design.upscaler import upscale_url
from packages.shared_py.config import get_settings
from packages.shared_py.db import get_db
from packages.shared_py.fal_http import download_image
from packages.shared_py.logger import get_logger
from packages.shared_py.notifier import notify_slack
from packages.shared_py.runtime_flags import get_runtime_flag

# Every finished design pauses at needs_review so the owner can approve, regen,
# or reject before Listing publishes. No auto-approve bypass — every agent in
# the pipeline pauses for human review of its output.
_DESIGN_OUTPUT_STATUS = "needs_review"


async def run() -> None:
    log = get_logger("design")
    db = get_db()

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
            await asyncio.to_thread(
                lambda: (
                    db.table("trend_briefs").update({"status": "done"}).eq("id", brief_id).execute()
                )
            )
            continue

        # existing_row may be None (first run) or processing without image_url (retry after storage failure)
        design_id: UUID = UUID(existing_row["id"]) if existing_row else uuid4()

        try:
            # build_image_prompt makes a blocking sync Anthropic HTTP call; offload
            # so the event loop (and any rate-limit semaphores it holds) stays alive.
            # Returns FluxPrompt for fal_flux_pro briefs, ImagePrompt for
            # fal_gpt_image_2 briefs — both have `.prompt` and `.style_descriptors`.
            image_prompt = await asyncio.to_thread(build_image_prompt, brief)
            # Hash includes image_model so identical prompt text against different
            # backends doesn't collide in the cross-row dedup cache.
            fal_prompt_hash = hashlib.sha256(
                f"{brief.image_model}:{image_prompt.prompt.strip()}".encode()
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
                                "image_model": brief.image_model,
                                "image_quality": brief.image_quality,
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
            # Backend dispatch: FLUX is the legacy small-output path that
            # needs the aura-sr upscaler; gpt-image-2's 2560×3072 native is
            # large enough to skip the upscaler entirely.
            if brief.image_model == "fal_flux_pro":
                # FluxPrompt path — validated, with negative_prompt + ritual phrases.
                work_url = await generate_flux_image_url(image_prompt)  # type: ignore[arg-type]
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
            upscaler_on = get_runtime_flag("upscaler_enabled", get_settings().upscaler_enabled)
            if brief.image_model == "fal_flux_pro" and upscaler_on:
                try:
                    work_url = await upscale_url(work_url)
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

            # Background removal — fal.ai only. Two interchangeable models
            # (birefnet v2 + bria 2.0): same I/O shape (URL in, transparent
            # RGBA PNG URL out), pick via runtime_flags.background_removal_mode.
            # On failure the design lands in 'error' and retries through the
            # normal 3-strike budget — no in-process fallback (the legacy
            # local rembg path was removed in migration 028).
            settings = get_settings()
            bg_mode = get_runtime_flag("background_removal_mode", settings.background_removal_mode)
            if bg_mode == "bria":
                work_url = await remove_background_bria_url(work_url)
            else:
                work_url = await remove_background_birefnet_url(work_url)

            # Two downloads — masked output (post-bg-removal) and pre-mask
            # preview (the original fal-generated image) — in parallel so
            # wall-clock is dominated by the slower of the two.
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

            image_url, image_url_unmasked = await asyncio.gather(
                asyncio.to_thread(upload_design, db, design_id, processed),
                asyncio.to_thread(
                    upload_design, db, design_id, processed_unmasked, suffix="-unmasked"
                ),
            )

            def _write_done() -> None:
                db.table("design_packages").update(
                    {
                        "image_url": image_url,
                        "image_url_unmasked": image_url_unmasked,
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

            # Retry counter lives on design_packages (not trend_briefs — trend_briefs.retry_count
            # belongs to the Scout). Read what's there, increment, and write the new error
            # state. If the row doesn't exist yet (exception fired before the insert) we
            # upsert a stub so the next retry can read its retry_count.
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

            # Any design failure is terminal: park trend_briefs at 'error' with the
            # message, alert Slack, and stop. No auto-retry, no revert to 'pending'.
            # Once a brief has been approved, the only way it leaves 'approved' →
            # 'processing' → 'done' is forward; failures require operator inspection
            # (re-approve the brief in the dashboard to retry). Do NOT touch
            # trend_briefs.retry_count — that counter belongs to Scout.
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

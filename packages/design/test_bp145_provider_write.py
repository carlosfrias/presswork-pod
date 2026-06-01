"""Tests asserting that blueprint-145 design_packages rows are written with
print_provider_id=39 (SwiftPOD) and a non-empty set of provider-39 variant IDs.

Two write sites are covered:
  1. _write_processing_stub INSERT branch — the heartbeat row created before the
     expensive fal pipeline fires.
  2. _write_cache_hit INSERT and UPDATE branches — the dedup path that reuses an
     already-generated image from a prior brief with the same prompt hash.

The variant catalog is stubbed at the db.table("printify_variant_catalog") level
so no real DB is touched. The stub returns the five canonical provider-39 White
variant IDs for blueprint 145 (38163, 38177, 38191, 38205, 38219), matching the
cloud catalog content confirmed by the investigation spec.
"""

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest

from packages.design.constants import (
    GILDAN_64000_BLUEPRINT_ID,
    GILDAN_64000_PRINT_PROVIDER_ID,
    GILDAN_64000_VARIANT_IDS,
)
from packages.design.main import run
from packages.shared_py.models import FluxPrompt, TrendBrief

# Provider-39 White S/M/L/XL/2XL — the canonical set from the cloud catalog.
# Matches the GILDAN_64000_VARIANT_IDS fallback list deliberately: the
# investigation confirmed these are the same IDs under provider 39.
_PROVIDER_39_WHITE_VARIANTS = [38163, 38177, 38191, 38205, 38219]

_FAKE_FLUX_URL = "https://fal.media/files/flux/output.png"
_FAKE_UPSCALED_URL = "https://cdn.fal.ai/aura-sr/upscaled.png"
_FAKE_BIREFNET_URL = "https://cdn.fal.ai/birefnet/transparent.png"
_FAKE_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
_FAKE_STORAGE_URL = "https://storage.example.com/designs/design.png"

_FLUX_PROMPT = FluxPrompt(
    prompt="print on demand design, mountains, white background",
    style_descriptors=["minimalist"],
)


def _make_brief(
    shirt_colors: list[str] | None = None,
    shirt_sizes: list[str] | None = None,
) -> TrendBrief:
    """Return a TrendBrief for blueprint 145 with the given color/size selections.
    Defaults match the DB schema defaults: White + S/M/L/XL/2XL."""
    colors = shirt_colors if shirt_colors is not None else ["White"]
    sizes = shirt_sizes if shirt_sizes is not None else ["S", "M", "L", "XL", "2XL"]
    return TrendBrief(
        id=uuid4(),
        created_at=datetime.now(tz=UTC),
        updated_at=datetime.now(tz=UTC),
        status="processing",
        niche="test-niche",
        retry_count=0,
        image_model="fal_flux_pro",
        shirt_colors=colors,
        shirt_sizes=sizes,
    )


def _make_catalog_db(catalog_rows: list[dict]) -> MagicMock:
    """Build a fake Supabase db that:
    - Returns `catalog_rows` for any printify_variant_catalog query.
    - Returns [] for the design_packages same-row guard (no existing row).
    - Returns [] for the cross-row dedup select (no cache hit by default).
    - Records insert/update calls on design_packages so tests can inspect them.
    """
    db = MagicMock()

    # Variant catalog stub — fluent chain: .select/.eq/.eq/.in_/.in_/.eq/.execute
    catalog_execute = MagicMock()
    catalog_execute.data = catalog_rows
    catalog_chain = MagicMock()
    catalog_chain.select.return_value = catalog_chain
    catalog_chain.eq.return_value = catalog_chain
    catalog_chain.in_.return_value = catalog_chain
    catalog_chain.execute.return_value = catalog_execute

    # design_packages mock — captures insert/update payloads.
    dp_mock = MagicMock()

    def dp_select(fields: str) -> MagicMock:
        result = MagicMock()
        if "retry_count" in fields:
            # Exception-handler retry-count select → no existing row
            result.eq.return_value.execute.return_value.data = []
        elif "mockup_urls" in fields or "image_url_unmasked" in fields:
            # Cross-row dedup select → no cache hit
            chain = MagicMock()
            chain.order.return_value.limit.return_value.execute.return_value.data = []
            result.eq.return_value.not_.is_.return_value = chain
        elif "metadata" in fields:
            # Pre-write metadata SELECT inside _write_done — empty row
            result.eq.return_value.execute.return_value.data = []
        else:
            # Same-row guard select("id,image_url,status") → no existing row
            result.eq.return_value.execute.return_value.data = []
        return result

    dp_mock.select.side_effect = dp_select

    tb_mock = MagicMock()

    def table_side_effect(name: str) -> MagicMock:
        if name == "printify_variant_catalog":
            return catalog_chain
        if name == "design_packages":
            return dp_mock
        return tb_mock  # trend_briefs and everything else

    db.table.side_effect = table_side_effect
    return db


def _make_catalog_db_with_cache_hit(
    catalog_rows: list[dict],
    cached_image_url: str = "https://storage.example.com/cached.png",
    existing_design_row: dict | None = None,
) -> MagicMock:
    """Variant of _make_catalog_db where the cross-row dedup SELECT returns a
    cache hit, triggering the _write_cache_hit path instead of the full pipeline.

    When existing_design_row is provided, the same-row guard also returns a match,
    so _write_cache_hit takes the UPDATE branch rather than INSERT.
    """
    db = MagicMock()

    catalog_execute = MagicMock()
    catalog_execute.data = catalog_rows
    catalog_chain = MagicMock()
    catalog_chain.select.return_value = catalog_chain
    catalog_chain.eq.return_value = catalog_chain
    catalog_chain.in_.return_value = catalog_chain
    catalog_chain.execute.return_value = catalog_execute

    dp_mock = MagicMock()

    def dp_select(fields: str) -> MagicMock:
        result = MagicMock()
        if "retry_count" in fields:
            result.eq.return_value.execute.return_value.data = []
        elif "mockup_urls" in fields or "image_url_unmasked" in fields:
            # Cross-row dedup → cache hit
            chain = MagicMock()
            chain.order.return_value.limit.return_value.execute.return_value.data = [
                {"image_url": cached_image_url, "image_url_unmasked": None, "mockup_urls": None}
            ]
            result.eq.return_value.not_.is_.return_value = chain
        elif "metadata" in fields:
            result.eq.return_value.execute.return_value.data = []
        else:
            # Same-row guard — optionally return an existing row
            if existing_design_row is not None:
                result.eq.return_value.execute.return_value.data = [existing_design_row]
            else:
                result.eq.return_value.execute.return_value.data = []
        return result

    dp_mock.select.side_effect = dp_select

    tb_mock = MagicMock()

    def table_side_effect(name: str) -> MagicMock:
        if name == "printify_variant_catalog":
            return catalog_chain
        if name == "design_packages":
            return dp_mock
        return tb_mock

    db.table.side_effect = table_side_effect
    return db


@pytest.fixture(autouse=True)
def _mock_pipeline(mocker):
    """Patch the full fal/storage pipeline so tests focus on DB write assertions.

    Every test in this module needs these; individual tests can override.
    """
    settings = MagicMock()
    settings.upscaler_enabled = True
    settings.background_removal_mode = "birefnet"
    mocker.patch("packages.design.main.get_settings", return_value=settings)
    mocker.patch(
        "packages.design.main.get_runtime_flag",
        side_effect=lambda _key, fallback: fallback,
    )
    mocker.patch("packages.design.main.upscale_url", AsyncMock(return_value=_FAKE_UPSCALED_URL))
    mocker.patch(
        "packages.design.main.remove_background_birefnet_url",
        AsyncMock(return_value=_FAKE_BIREFNET_URL),
    )
    mocker.patch(
        "packages.design.main.remove_background_bria_url",
        AsyncMock(return_value=_FAKE_BIREFNET_URL),
    )
    mocker.patch("packages.design.main.download_image", AsyncMock(return_value=_FAKE_PNG))
    mocker.patch("packages.design.main.run_remask_sweep", AsyncMock())
    mocker.patch(
        "packages.design.main.generate_flux_image_url",
        AsyncMock(return_value=_FAKE_FLUX_URL),
    )
    mocker.patch("packages.design.main.process_for_print", return_value=_FAKE_PNG)
    mocker.patch("packages.design.main.upload_design", return_value=_FAKE_STORAGE_URL)
    mocker.patch("packages.design.main.record_usage")
    mocker.patch("packages.design.main.build_image_prompt", return_value=_FLUX_PROMPT)


# ---------------------------------------------------------------------------
# _write_processing_stub INSERT branch (new design row, no existing row)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_processing_stub_insert_writes_provider_39(mocker):
    """The heartbeat INSERT written before the fal pipeline fires must carry
    printify_print_provider_id = GILDAN_64000_PRINT_PROVIDER_ID (39)."""
    brief = _make_brief()
    catalog_rows = [
        {"variant_id": 38163},
        {"variant_id": 38177},
        {"variant_id": 38191},
        {"variant_id": 38205},
        {"variant_id": 38219},
    ]
    db = _make_catalog_db(catalog_rows)

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)

    await run()

    dp_mock = db.table("design_packages")
    insert_calls = dp_mock.insert.call_args_list
    assert insert_calls, "Expected at least one design_packages.insert call"

    # The processing-stub INSERT fires before upload_design, so it's the first insert.
    first_payload = insert_calls[0].args[0]
    assert first_payload.get("printify_print_provider_id") == GILDAN_64000_PRINT_PROVIDER_ID, (
        f"Expected provider_id={GILDAN_64000_PRINT_PROVIDER_ID}, "
        f"got {first_payload.get('printify_print_provider_id')}"
    )


@pytest.mark.asyncio
async def test_processing_stub_insert_writes_blueprint_145(mocker):
    """The heartbeat INSERT must also carry printify_blueprint_id = 145."""
    brief = _make_brief()
    catalog_rows = [{"variant_id": 38163}]
    db = _make_catalog_db(catalog_rows)

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)

    await run()

    dp_mock = db.table("design_packages")
    first_payload = dp_mock.insert.call_args_list[0].args[0]
    assert first_payload.get("printify_blueprint_id") == GILDAN_64000_BLUEPRINT_ID, (
        f"Expected blueprint_id={GILDAN_64000_BLUEPRINT_ID}, "
        f"got {first_payload.get('printify_blueprint_id')}"
    )


@pytest.mark.asyncio
async def test_processing_stub_insert_writes_nonempty_variant_ids(mocker):
    """The heartbeat INSERT must carry a non-empty printify_variant_ids list
    sourced from the variant catalog for provider 39."""
    brief = _make_brief()
    catalog_rows = [
        {"variant_id": 38163},
        {"variant_id": 38177},
        {"variant_id": 38191},
        {"variant_id": 38205},
        {"variant_id": 38219},
    ]
    db = _make_catalog_db(catalog_rows)

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)

    await run()

    dp_mock = db.table("design_packages")
    first_payload = dp_mock.insert.call_args_list[0].args[0]
    variant_ids = first_payload.get("printify_variant_ids")
    assert variant_ids, f"Expected non-empty printify_variant_ids, got {variant_ids!r}"
    assert isinstance(variant_ids, list)
    assert len(variant_ids) > 0


@pytest.mark.asyncio
async def test_processing_stub_insert_variant_ids_match_catalog_rows(mocker):
    """The variant IDs written to the INSERT row must exactly match the set
    returned by resolve_variant_ids for provider 39 — sorted, deduplicated."""
    brief = _make_brief()
    # Catalog returns 3 of the 5 standard White variants.
    catalog_rows = [
        {"variant_id": 38205},
        {"variant_id": 38163},
        {"variant_id": 38205},  # duplicate
    ]
    db = _make_catalog_db(catalog_rows)

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)

    await run()

    dp_mock = db.table("design_packages")
    first_payload = dp_mock.insert.call_args_list[0].args[0]
    variant_ids = first_payload.get("printify_variant_ids")
    # Sorted distinct IDs only (deduplicated).
    assert variant_ids == [38163, 38205], (
        f"Expected [38163, 38205] (sorted, deduped), got {variant_ids}"
    )


@pytest.mark.asyncio
async def test_processing_stub_insert_fallback_when_catalog_empty(mocker):
    """When the catalog query returns no rows, resolve_variant_ids falls back to
    GILDAN_64000_VARIANT_IDS. The INSERT must use that fallback list — still a
    valid provider-39 set — rather than an empty list."""
    brief = _make_brief()
    db = _make_catalog_db(catalog_rows=[])

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)

    await run()

    dp_mock = db.table("design_packages")
    first_payload = dp_mock.insert.call_args_list[0].args[0]
    variant_ids = first_payload.get("printify_variant_ids")
    # Fallback must equal the canonical default set.
    assert variant_ids == GILDAN_64000_VARIANT_IDS, (
        f"Expected fallback GILDAN_64000_VARIANT_IDS={GILDAN_64000_VARIANT_IDS}, got {variant_ids}"
    )


@pytest.mark.asyncio
async def test_catalog_queried_with_provider_39(mocker):
    """resolve_variant_ids must query the catalog with print_provider_id=39.
    We verify this by checking that the catalog table's .eq chain received
    print_provider_id=39 as one of its eq calls."""
    brief = _make_brief(shirt_colors=["White"], shirt_sizes=["M"])
    db = MagicMock()

    # Track eq() calls on the catalog chain.
    eq_args: list[tuple] = []

    catalog_execute = MagicMock()
    catalog_execute.data = [{"variant_id": 38177}]
    catalog_chain = MagicMock()
    catalog_chain.select.return_value = catalog_chain
    catalog_chain.execute.return_value = catalog_execute

    def catalog_eq(*args, **kwargs):
        eq_args.append(args)
        return catalog_chain

    catalog_chain.eq.side_effect = catalog_eq
    catalog_chain.in_.return_value = catalog_chain

    dp_mock = MagicMock()

    def dp_select(fields: str) -> MagicMock:
        result = MagicMock()
        if "retry_count" in fields:
            result.eq.return_value.execute.return_value.data = []
        elif "mockup_urls" in fields or "image_url_unmasked" in fields:
            chain = MagicMock()
            chain.order.return_value.limit.return_value.execute.return_value.data = []
            result.eq.return_value.not_.is_.return_value = chain
        elif "metadata" in fields:
            result.eq.return_value.execute.return_value.data = []
        else:
            result.eq.return_value.execute.return_value.data = []
        return result

    dp_mock.select.side_effect = dp_select
    tb_mock = MagicMock()

    def table_side_effect(name: str) -> MagicMock:
        if name == "printify_variant_catalog":
            return catalog_chain
        if name == "design_packages":
            return dp_mock
        return tb_mock

    db.table.side_effect = table_side_effect

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)

    await run()

    # Confirm the catalog was queried with print_provider_id=39.
    provider_eq_calls = [args for args in eq_args if args == ("print_provider_id", 39)]
    assert provider_eq_calls, (
        f"Expected catalog query with eq('print_provider_id', 39), got eq calls: {eq_args}"
    )


# ---------------------------------------------------------------------------
# _write_cache_hit INSERT branch (dedup: no existing row, cache hit)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cache_hit_insert_writes_provider_39(mocker):
    """When the cross-row dedup cache fires and no existing design_packages row
    exists (INSERT branch), the new row must carry printify_print_provider_id=39."""
    brief = _make_brief()
    catalog_rows = [
        {"variant_id": 38163},
        {"variant_id": 38177},
        {"variant_id": 38191},
        {"variant_id": 38205},
        {"variant_id": 38219},
    ]
    db = _make_catalog_db_with_cache_hit(catalog_rows)

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)

    await run()

    dp_mock = db.table("design_packages")
    insert_calls = dp_mock.insert.call_args_list
    assert insert_calls, "Expected a design_packages.insert call on the cache-hit path"

    payload = insert_calls[0].args[0]
    assert payload.get("printify_print_provider_id") == GILDAN_64000_PRINT_PROVIDER_ID, (
        f"cache-hit INSERT: expected provider_id=39, got "
        f"{payload.get('printify_print_provider_id')}"
    )


@pytest.mark.asyncio
async def test_cache_hit_insert_writes_nonempty_variant_ids(mocker):
    """cache-hit INSERT must carry a non-empty printify_variant_ids."""
    brief = _make_brief()
    catalog_rows = [{"variant_id": 38163}, {"variant_id": 38177}]
    db = _make_catalog_db_with_cache_hit(catalog_rows)

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)

    await run()

    dp_mock = db.table("design_packages")
    payload = dp_mock.insert.call_args_list[0].args[0]
    variant_ids = payload.get("printify_variant_ids")
    assert variant_ids, f"cache-hit INSERT: expected non-empty variant_ids, got {variant_ids!r}"
    assert sorted(variant_ids) == [38163, 38177]


# ---------------------------------------------------------------------------
# _write_cache_hit UPDATE branch (dedup: existing row present, cache hit)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cache_hit_update_writes_provider_39(mocker):
    """When the cross-row dedup cache fires and an existing design_packages row
    IS present (UPDATE branch), the update payload must carry
    printify_print_provider_id=39 so stale provider-3 rows get corrected."""
    brief = _make_brief()
    existing_design_id = str(uuid4())
    existing_row = {"id": existing_design_id, "image_url": None, "status": "processing"}
    catalog_rows = [
        {"variant_id": 38163},
        {"variant_id": 38177},
        {"variant_id": 38191},
        {"variant_id": 38205},
        {"variant_id": 38219},
    ]
    db = _make_catalog_db_with_cache_hit(catalog_rows, existing_design_row=existing_row)

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)

    await run()

    dp_mock = db.table("design_packages")
    update_calls = dp_mock.update.call_args_list
    assert update_calls, "Expected a design_packages.update call on the cache-hit UPDATE path"

    # The first update is the cache-hit update (not a status lift, which would
    # have no provider field).  Find the update that sets provider.
    provider_updates = [
        call.args[0]
        for call in update_calls
        if call.args and "printify_print_provider_id" in call.args[0]
    ]
    assert provider_updates, "Expected an update payload containing printify_print_provider_id"
    assert provider_updates[0]["printify_print_provider_id"] == GILDAN_64000_PRINT_PROVIDER_ID, (
        f"cache-hit UPDATE: expected provider_id=39, "
        f"got {provider_updates[0]['printify_print_provider_id']}"
    )


@pytest.mark.asyncio
async def test_cache_hit_update_writes_nonempty_variant_ids(mocker):
    """cache-hit UPDATE must carry non-empty printify_variant_ids so an existing
    provider-3 row gets its variant list refreshed to the provider-39 IDs."""
    brief = _make_brief()
    existing_design_id = str(uuid4())
    existing_row = {"id": existing_design_id, "image_url": None, "status": "processing"}
    catalog_rows = [{"variant_id": 38163}, {"variant_id": 38205}]
    db = _make_catalog_db_with_cache_hit(catalog_rows, existing_design_row=existing_row)

    mocker.patch("packages.design.main.claim_next_brief", side_effect=[brief, None])
    mocker.patch("packages.design.main.get_db", return_value=db)

    await run()

    dp_mock = db.table("design_packages")
    provider_updates = [
        call.args[0]
        for call in dp_mock.update.call_args_list
        if call.args and "printify_variant_ids" in call.args[0]
    ]
    assert provider_updates, "Expected an update with printify_variant_ids"
    variant_ids = provider_updates[0]["printify_variant_ids"]
    assert variant_ids, f"Expected non-empty variant_ids in update, got {variant_ids!r}"
    assert sorted(variant_ids) == [38163, 38205]


# ---------------------------------------------------------------------------
# Invariant: GILDAN_64000_PRINT_PROVIDER_ID constant is 39
# ---------------------------------------------------------------------------


def test_gildan_64000_print_provider_id_constant_is_39():
    """Regression guard: GILDAN_64000_PRINT_PROVIDER_ID must equal 39 (SwiftPOD).
    If someone accidentally changes the constant, every new design_packages row
    gets the wrong provider and assertBlueprintSupported in the Listing Agent
    rejects it at publish time.
    """
    assert GILDAN_64000_PRINT_PROVIDER_ID == 39, (
        f"GILDAN_64000_PRINT_PROVIDER_ID changed from 39 to {GILDAN_64000_PRINT_PROVIDER_ID}. "
        "This breaks Listing Agent blueprint validation. Update the constant back to 39 "
        "(SwiftPOD) or update this test if a provider migration was intentional."
    )


def test_gildan_64000_blueprint_id_constant_is_145():
    """Regression guard: GILDAN_64000_BLUEPRINT_ID must equal 145."""
    assert GILDAN_64000_BLUEPRINT_ID == 145, (
        f"GILDAN_64000_BLUEPRINT_ID changed from 145 to {GILDAN_64000_BLUEPRINT_ID}."
    )


def test_gildan_64000_variant_ids_are_nonempty():
    """The canonical fallback variant list must never be empty — an empty list
    would write no variants and cause Printify product creation to fail."""
    assert GILDAN_64000_VARIANT_IDS, (
        "GILDAN_64000_VARIANT_IDS is empty — every design_packages insert would "
        "carry an empty variant list, breaking Printify product creation."
    )
    assert all(isinstance(v, int) and v > 0 for v in GILDAN_64000_VARIANT_IDS), (
        f"All entries in GILDAN_64000_VARIANT_IDS must be positive integers, "
        f"got {GILDAN_64000_VARIANT_IDS}"
    )


def test_provider_39_variant_ids_match_canonical_set():
    """The five canonical provider-39 White S/M/L/XL/2XL IDs confirmed by the
    cloud catalog investigation must appear in GILDAN_64000_VARIANT_IDS."""
    expected = set(_PROVIDER_39_WHITE_VARIANTS)
    actual = set(GILDAN_64000_VARIANT_IDS)
    assert expected == actual, (
        f"GILDAN_64000_VARIANT_IDS mismatch.\n"
        f"  Expected (provider-39 White S/M/L/XL/2XL): {sorted(expected)}\n"
        f"  Actual: {sorted(actual)}\n"
        "Update GILDAN_64000_VARIANT_IDS in constants.py if the catalog has changed, "
        "or correct the expected set in this test."
    )

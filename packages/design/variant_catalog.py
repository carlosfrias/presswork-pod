"""Resolve Printify variant IDs from the printify_variant_catalog table.

Translates operator-selected shirt_colors and shirt_sizes into the exact
Printify variant IDs needed for product creation.
"""

from typing import Any, cast

from packages.design.constants import GILDAN_64000_VARIANT_IDS
from packages.shared_py.logger import get_logger
from supabase import Client

_log = get_logger("design")


def resolve_variant_ids(
    db: Client,
    blueprint_id: int,
    provider_id: int,
    colors: list[str],
    sizes: list[str],
) -> list[int]:
    """Return the sorted list of distinct variant_id ints matching the given
    blueprint/provider/colors/sizes from printify_variant_catalog.

    Falls back to GILDAN_64000_VARIANT_IDS (White S/M/L/XL/2XL) when:
    - colors or sizes is empty, OR
    - the catalog query returns no rows.

    Args:
        db: Supabase client (from packages.shared_py.db.get_db).
        blueprint_id: Printify blueprint ID (e.g. 145 for Gildan 64000).
        provider_id: Printify print provider ID (e.g. 39 for SwiftPOD).
        colors: List of color names as stored in printify_variant_catalog.
        sizes: List of size labels as stored in printify_variant_catalog.

    Returns:
        Sorted list of distinct variant_id integers.
    """
    if not colors or not sizes:
        _log.warning(
            "resolve_variant_ids_fallback",
            agent="design",
            action="resolve_variant_ids",
            reason="empty_colors_or_sizes",
            colors=colors,
            sizes=sizes,
            fallback_count=len(GILDAN_64000_VARIANT_IDS),
        )
        return list(GILDAN_64000_VARIANT_IDS)

    resp = (
        db.table("printify_variant_catalog")
        .select("variant_id")
        .eq("blueprint_id", blueprint_id)
        .eq("print_provider_id", provider_id)
        .in_("color", colors)
        .in_("size", sizes)
        .eq("is_available", True)
        .execute()
    )

    rows = cast(list[dict[str, Any]], resp.data or [])
    variant_ids = sorted({int(row["variant_id"]) for row in rows})

    if not variant_ids:
        _log.warning(
            "resolve_variant_ids_fallback",
            agent="design",
            action="resolve_variant_ids",
            reason="no_catalog_rows",
            blueprint_id=blueprint_id,
            provider_id=provider_id,
            colors=colors,
            sizes=sizes,
            fallback_count=len(GILDAN_64000_VARIANT_IDS),
        )
        return list(GILDAN_64000_VARIANT_IDS)

    return variant_ids

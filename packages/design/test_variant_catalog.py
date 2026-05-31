"""Unit tests for packages.design.variant_catalog.resolve_variant_ids.

Mocks the Supabase db object — does not hit a real database.
"""

from unittest.mock import MagicMock

from packages.design.constants import GILDAN_64000_VARIANT_IDS
from packages.design.variant_catalog import resolve_variant_ids

_BLUEPRINT_ID = 145
_PROVIDER_ID = 39


def _make_db(rows: list[dict]) -> MagicMock:
    """Build a minimal fake db whose fluent chain returns the given rows.

    Mirrors the supabase-py call shape:
        db.table("printify_variant_catalog")
          .select("variant_id")
          .eq("blueprint_id", ...)
          .eq("print_provider_id", ...)
          .in_("color", [...])
          .in_("size", [...])
          .eq("is_available", True)
          .execute()
          -> object with .data = rows
    """
    execute_result = MagicMock()
    execute_result.data = rows

    # Build a chain mock where every intermediate call returns `chain` so
    # any sequence of .select/.eq/.in_/.execute resolves correctly.
    chain = MagicMock()
    chain.select.return_value = chain
    chain.eq.return_value = chain
    chain.in_.return_value = chain
    chain.execute.return_value = execute_result

    db = MagicMock()
    db.table.return_value = chain
    return db


class TestResolveVariantIds:
    def test_catalog_rows_return_correct_sorted_ids(self) -> None:
        """When the catalog has matching rows, returns a sorted list of distinct
        variant_id ints."""
        catalog_rows = [
            {"variant_id": 38205},
            {"variant_id": 38163},
            {"variant_id": 38191},
            {"variant_id": 38205},  # duplicate — should be deduplicated
        ]
        db = _make_db(catalog_rows)

        result = resolve_variant_ids(
            db,
            _BLUEPRINT_ID,
            _PROVIDER_ID,
            colors=["White", "Black"],
            sizes=["S", "M", "L"],
        )

        assert result == [38163, 38191, 38205]

    def test_empty_colors_returns_fallback(self) -> None:
        """When colors is an empty list, falls back to GILDAN_64000_VARIANT_IDS
        without touching the database."""
        db = _make_db([])

        result = resolve_variant_ids(
            db,
            _BLUEPRINT_ID,
            _PROVIDER_ID,
            colors=[],
            sizes=["S", "M", "L"],
        )

        assert result == GILDAN_64000_VARIANT_IDS
        # DB should not have been queried
        db.table.assert_not_called()

    def test_empty_sizes_returns_fallback(self) -> None:
        """When sizes is an empty list, falls back to GILDAN_64000_VARIANT_IDS
        without touching the database."""
        db = _make_db([])

        result = resolve_variant_ids(
            db,
            _BLUEPRINT_ID,
            _PROVIDER_ID,
            colors=["White"],
            sizes=[],
        )

        assert result == GILDAN_64000_VARIANT_IDS
        db.table.assert_not_called()

    def test_empty_query_result_returns_fallback(self) -> None:
        """When the catalog query returns no rows (no matching color/size
        combinations), falls back to GILDAN_64000_VARIANT_IDS."""
        db = _make_db([])

        result = resolve_variant_ids(
            db,
            _BLUEPRINT_ID,
            _PROVIDER_ID,
            colors=["NonexistentColor"],
            sizes=["XXXL"],
        )

        assert result == GILDAN_64000_VARIANT_IDS
        # DB WAS queried — it just returned no rows
        db.table.assert_called_once_with("printify_variant_catalog")

    def test_single_match_returns_single_id(self) -> None:
        """A single catalog row produces a list with one element."""
        db = _make_db([{"variant_id": 38177}])

        result = resolve_variant_ids(
            db,
            _BLUEPRINT_ID,
            _PROVIDER_ID,
            colors=["White"],
            sizes=["M"],
        )

        assert result == [38177]

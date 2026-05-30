"""Unit tests for the cross-language Etsy token contract.

The config.etsy_oauth row is shared with the TS agents, which read/write it
with camelCase keys (packages/shared/src/etsy-tokens.ts). These tests lock the
Python side to that same shape — a snake_case regression here crashes Scout and
Design with KeyError on the first Etsy call.
"""

from datetime import UTC, datetime
from unittest.mock import MagicMock

from packages.shared_py.etsy_tokens import EtsyTokens, load_tokens, save_tokens


def _db_with_config(value: object) -> MagicMock:
    db = MagicMock()
    resp = MagicMock()
    resp.data = [{"value": value}]
    db.table.return_value.select.return_value.eq.return_value.execute.return_value = resp
    return db


def test_load_tokens_reads_camelcase_row_written_by_ts():
    db = _db_with_config(
        {
            "accessToken": "ts-access",
            "refreshToken": "ts-refresh",
            "expiresAt": "2099-01-01T00:00:00+00:00",
        }
    )

    tokens = load_tokens(db)

    assert tokens.access_token == "ts-access"
    assert tokens.refresh_token == "ts-refresh"
    assert tokens.expires_at == datetime(2099, 1, 1, tzinfo=UTC)


def test_save_tokens_persists_camelcase_shape():
    db = MagicMock()
    tokens = EtsyTokens(
        access_token="a",
        refresh_token="r",
        expires_at=datetime(2099, 1, 1, tzinfo=UTC),
    )

    save_tokens(db, tokens)

    upsert_arg = db.table.return_value.upsert.call_args.args[0]
    assert upsert_arg["key"] == "etsy_oauth"
    assert upsert_arg["value"] == {
        "accessToken": "a",
        "refreshToken": "r",
        "expiresAt": "2099-01-01T00:00:00+00:00",
    }

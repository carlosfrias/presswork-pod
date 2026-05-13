"""Unit tests for the shared_py.db singleton lifecycle."""

from unittest.mock import MagicMock

from packages.shared_py import db as db_module


def _patch_settings(mocker, *, role_key: str = "sb_secret_test"):
    """Return a fake settings object the way get_settings() does."""
    fake_settings = MagicMock()
    fake_settings.supabase_url = "https://example.supabase.co"
    fake_settings.supabase_service_role_key = role_key
    mocker.patch("packages.shared_py.db.get_settings", return_value=fake_settings)


def test_get_db_returns_singleton_within_process(mocker):
    _patch_settings(mocker)
    sentinel = MagicMock(name="supabase_client")
    create = mocker.patch("packages.shared_py.db.create_client", return_value=sentinel)

    first = db_module.get_db()
    second = db_module.get_db()

    # Singleton identity — second call returns the same client without
    # rebuilding.
    assert first is second
    assert create.call_count == 1


def test_reset_db_client_forces_rebuild(mocker):
    _patch_settings(mocker)
    create = mocker.patch(
        "packages.shared_py.db.create_client",
        side_effect=[MagicMock(name="first"), MagicMock(name="second")],
    )

    first = db_module.get_db()
    db_module._reset_db_client()
    second = db_module.get_db()

    assert first is not second
    assert create.call_count == 2


def test_get_db_rejects_anon_key(mocker):
    # Anon keys ('sb_publishable_...' or anon JWTs) must never be used
    # for the service-role client. _is_service_role_key returns False, so
    # get_db raises before create_client is touched.
    _patch_settings(mocker, role_key="sb_publishable_not_a_service_key")
    create = mocker.patch("packages.shared_py.db.create_client")

    try:
        db_module.get_db()
    except RuntimeError as exc:
        assert "service role" in str(exc).lower()
    else:  # pragma: no cover - failure path
        raise AssertionError("expected RuntimeError for non-service-role key")

    create.assert_not_called()

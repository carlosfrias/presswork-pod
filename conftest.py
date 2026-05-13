# Root conftest — pytest adds this directory to sys.path automatically,
# making `packages.shared_py` and `packages.scout` importable in all tests.

import pytest


@pytest.fixture(autouse=True)
def _reset_module_caches():
    """Reset process-scoped caches between tests so state from one test
    can't leak into the next. Both ``shared_py.db`` and
    ``shared_py.runtime_flags`` hold module-level singletons that would
    otherwise survive across the entire test run.

    Production code never calls these helpers; they exist solely for
    test isolation (see AUDIT_4 C4 / M9).
    """
    from packages.shared_py.db import _reset_db_client
    from packages.shared_py.runtime_flags import _reset_runtime_flag_cache

    _reset_db_client()
    _reset_runtime_flag_cache()
    yield
    _reset_db_client()
    _reset_runtime_flag_cache()

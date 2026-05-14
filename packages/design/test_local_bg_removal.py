"""Tests for the local rembg background-removal path.

Mirrors test_birefnet.py's mock structure, except there's no fal client to
patch — the only external dependency is rembg.remove, imported as
rembg_remove. We patch it at the import site so tests don't touch onnxruntime
or download the U²-Net weight.
"""

from unittest.mock import MagicMock

from packages.design.local_bg_removal import remove_background_local

_INPUT_BYTES = b"\x89PNG\r\n\x1a\n-fake-input-bytes-"
_OUTPUT_BYTES = b"\x89PNG\r\n\x1a\n-fake-transparent-output-"


async def test_happy_path_returns_rembg_output(mocker):
    rembg_mock = mocker.patch(
        "packages.design.local_bg_removal.rembg_remove",
        return_value=_OUTPUT_BYTES,
    )

    result = await remove_background_local(_INPUT_BYTES)

    assert result == _OUTPUT_BYTES
    rembg_mock.assert_called_once_with(_INPUT_BYTES)


async def test_runs_in_worker_thread_not_event_loop(mocker):
    """Regression guard: rembg is CPU-bound and must not block the loop.
    asyncio.to_thread is the only acceptable executor here."""
    to_thread_mock = mocker.patch(
        "packages.design.local_bg_removal.asyncio.to_thread",
        new=MagicMock(),
    )

    # to_thread must be awaitable; wrap return in a coroutine.
    async def _coro():
        return _OUTPUT_BYTES

    to_thread_mock.return_value = _coro()

    result = await remove_background_local(_INPUT_BYTES)

    assert result == _OUTPUT_BYTES
    to_thread_mock.assert_called_once()
    # First positional arg is the function being offloaded — must be rembg_remove.
    from packages.design.local_bg_removal import rembg_remove

    assert to_thread_mock.call_args.args[0] is rembg_remove
    assert to_thread_mock.call_args.args[1] == _INPUT_BYTES

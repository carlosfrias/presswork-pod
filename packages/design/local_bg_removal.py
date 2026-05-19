"""In-process background removal via rembg U²-Net.

Sibling to packages/design/birefnet.py and packages/design/bria.py but with a
different I/O shape on purpose: those two are URL-in / URL-out (the fal pipeline
threads a fal-hosted URL through every stage), while this one is bytes-in /
bytes-out. The dispatcher in main.py / remask.py branches on bg_mode == "local"
and downloads the upstream fal URL ONCE, hands the bytes here, and uses the
returned bytes directly — no round-trip back to fal storage.

Why bytes instead of mirroring the URL contract: the local path's whole point
is to avoid fal calls. Re-uploading rembg output to fal would burn a network
round-trip for no gain. Keeping the function signature different makes the
dispatcher branch explicit at the call site.

History: this was the original implementation (commit f3f16a8 — fix(design):
use rembg for background removal in image processor) before the pipeline went
URL-threaded. Reintroduced here as the free default so the two fal backends
become opt-in fallbacks for designs where rembg leaves halos or eats detail.

Operational note: rembg downloads the ~170MB U²-Net ONNX weight to ~/.u2net/
on first call. Subsequent calls reuse the cached weight. In a fresh container
this adds ~10-20s to the first Design run only.
"""

import asyncio
from typing import cast

from rembg import remove as rembg_remove


async def remove_background_local(png_bytes: bytes) -> bytes:
    """Run rembg U²-Net on bytes in a worker thread, return transparent PNG bytes.

    asyncio.to_thread keeps the event loop unblocked during the ~2-4s CPU
    inference so other Design-agent coroutines (status writes, logging) can
    progress while the cutout runs.
    """
    return cast(bytes, await asyncio.to_thread(rembg_remove, png_bytes))

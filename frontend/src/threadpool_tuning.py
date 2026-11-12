"""ORW-176 - the one knob for the request thread pool.

FastAPI/Starlette run every plain ``def`` handler (and ``asyncio.to_thread`` -> anyio) on a worker-thread pool whose default is 40 tokens. The
front-end is ONE process (see docs/design/frontend-single-worker-ceiling.md), so that pool is the whole concurrency budget for blocking work
(SQLite, engine-bridge calls, file IO). Unset => the anyio default stays exactly as it was; ``ORWELL_THREADPOOL_SIZE`` raises or lowers it
for a box that has been measured to want it. Out-of-range or non-numeric values are ignored (logged), never fatal."""
from __future__ import annotations

import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)

MIN_SIZE = 8
MAX_SIZE = 400


def requested_size(environ: Optional[dict] = None) -> Optional[int]:
    """The valid requested pool size, or None when unset/invalid (the default then stands)."""
    raw = (environ if environ is not None else os.environ).get("ORWELL_THREADPOOL_SIZE", "").strip()
    if not raw:
        return None
    try:
        n = int(raw)
    except ValueError:
        logger.warning("[threadpool] ORWELL_THREADPOOL_SIZE=%r is not an integer; keeping the default", raw)
        return None
    if not MIN_SIZE <= n <= MAX_SIZE:
        logger.warning("[threadpool] ORWELL_THREADPOOL_SIZE=%d is outside %d..%d; keeping the default", n, MIN_SIZE, MAX_SIZE)
        return None
    return n


def apply_threadpool_size(limiter=None, environ: Optional[dict] = None) -> Optional[int]:
    """Set the anyio default thread limiter's tokens when a valid size is requested. Returns the size applied, else None. Must run on the event loop."""
    n = requested_size(environ)
    if n is None:
        return None
    if limiter is None:
        import anyio.to_thread
        limiter = anyio.to_thread.current_default_thread_limiter()
    limiter.total_tokens = n
    return n

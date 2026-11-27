"""ORW-1026: a counted, rate-limited home for the formerly silent ``except Exception: pass`` sites.

A site that must not break the turn still must not vanish: it calls ``note(site, exc)``. The first hit of a
site and then at most one hit per ``_LOG_EVERY_S`` seconds are logged (WARNING, class name only: never the
message text, which may carry player or cast content); every hit is counted. ``snapshot()`` feeds the doctor.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Dict, Optional

logger = logging.getLogger(__name__)

_LOG_EVERY_S = 300.0
_lock = threading.Lock()
_counts: Dict[str, int] = {}
_last_log: Dict[str, float] = {}
_last_class: Dict[str, str] = {}
_MAX_SITES = 1000  # bounded: a bug that mints ids cannot grow this without limit


def note(site: str, exc: Optional[BaseException] = None) -> None:
    """Count one swallowed failure at ``site`` and log it, rate-limited. Never raises."""
    try:
        now = time.monotonic()
        cls = type(exc).__name__ if exc is not None else "unknown"
        with _lock:
            if site not in _counts and len(_counts) >= _MAX_SITES:
                site = "overflow"
            n = _counts.get(site, 0) + 1
            _counts[site] = n
            _last_class[site] = cls
            last = _last_log.get(site)
            due = last is None or (now - last) >= _LOG_EVERY_S
            if due:
                _last_log[site] = now
        if due:
            logger.warning("[failsoft] %s swallowed %s (count=%d; logged at most every %ds per site)", site, cls, n, int(_LOG_EVERY_S))
    except Exception:  # noqa: BLE001 - failsoft-ok: the counter itself must never break the caller
        pass


def snapshot() -> Dict[str, Dict[str, object]]:
    """Per-site counts and the last exception class, for the doctor and tests."""
    with _lock:
        return {s: {"count": c, "last_class": _last_class.get(s, "")} for s, c in sorted(_counts.items())}


def reset_for_tests() -> None:
    with _lock:
        _counts.clear()
        _last_log.clear()
        _last_class.clear()

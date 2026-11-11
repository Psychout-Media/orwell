"""ORW-202 - keep the narrator's pacing / stall-recovery / re-ground bookkeeping across a front-end restart.

The stall-nudge ladder, the staleness clock, the anti-stale counters (``agent_loop``) and the queued
next-turn re-ground FIFO (``chat_helpers._DESYNC_REGROUND``) live in process memory, so a restart during a
live game silently dropped them (a pending re-ground was lost, entrance pacing restarted from zero).

This module snapshots exactly those stores to one small JSON file under ``DATA_DIR`` (atomic write, the
``orwell_game_session`` pattern), saves at the end of each turn (debounced, on a timer thread, off the hot
path), and restores into EMPTY stores at startup. Closed-set bookkeeping only: Vault-free ints and the
engine-facing correction strings the FE already composes. A missing or corrupt file never breaks startup.
"""

from __future__ import annotations

import json
import logging
import threading
from pathlib import Path

from core.atomic_io import atomic_write_json
from src.constants import DATA_DIR

logger = logging.getLogger(__name__)

BELT_STATE_PATH = Path(DATA_DIR) / "orwell_belt_state.json"
_DEBOUNCE_SECONDS = 1.0
_LOCK = threading.Lock()
_TIMER: "threading.Timer | None" = None

# The agent_loop int-valued stores, by attribute name.
_INT_STORES = (
    "_TURNS_SINCE_PROGRESS", "_ADVANCE_STALL_LEVEL", "_ADVANCE_STALL_FLAGS",
    "_SILENT_FORCE_ADVANCE_STREAK", "_ANTI_STALE_CAP_HOLDS",
)
_REGROUND_STORE = "_DESYNC_REGROUND"


def _stores():
    """(agent_loop int stores by name, the re-ground dict). Imported lazily: both modules import heavily."""
    from src import agent_loop
    from routes import chat_helpers
    return {n: getattr(agent_loop, n) for n in _INT_STORES}, getattr(chat_helpers, _REGROUND_STORE)


def snapshot() -> dict:
    ints, reground = _stores()
    return {
        "v": 1,
        "ints": {n: {str(k): int(v) for k, v in dict(s).items()} for n, s in ints.items()},
        "reground": {str(k): str(v) for k, v in dict(reground).items() if v},
    }


def save_now() -> None:
    """Write the current stores to disk. Never raises."""
    try:
        with _LOCK:
            atomic_write_json(str(BELT_STATE_PATH), snapshot(), indent=2)
    except Exception:  # failsoft-ok: best-effort durability; a failed save must never break a turn (the in-memory state still stands)
        logger.warning("[orwell] belt-state save failed", exc_info=True)


def save_soon() -> None:
    """Debounced save for the turn-end hook: coalesces bursts into one trailing write on a daemon timer."""
    global _TIMER
    with _LOCK:
        if _TIMER is not None:
            return
        t = threading.Timer(_DEBOUNCE_SECONDS, _timer_fire)
        t.daemon = True
        _TIMER = t
        t.start()


def _timer_fire() -> None:
    global _TIMER
    with _LOCK:
        _TIMER = None
    save_now()


def restore() -> int:
    """Load the file into stores that are still EMPTY (never overwrites live state). Returns the entries
    restored; a missing or corrupt file restores nothing and never raises."""
    try:
        data = json.loads(BELT_STATE_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return 0
    except Exception:  # failsoft-ok: a corrupt file must never break startup; fall back to empty stores
        logger.warning("[orwell] belt-state file unreadable; starting with empty pacing state", exc_info=True)
        return 0
    n = 0
    try:
        if not isinstance(data, dict):
            return 0
        ints, reground = _stores()
        for name, store in ints.items():
            saved = (data.get("ints") or {}).get(name)
            if store or not isinstance(saved, dict):
                continue
            for k, v in saved.items():
                if isinstance(k, str) and isinstance(v, int) and not isinstance(v, bool):
                    store[k] = v
                    n += 1
        saved_rg = data.get("reground")
        if not reground and isinstance(saved_rg, dict):
            for k, v in saved_rg.items():
                if isinstance(k, str) and isinstance(v, str) and v:
                    reground[k] = v
                    n += 1
    except Exception:  # failsoft-ok: restore is best-effort; whatever was applied stands, startup continues
        logger.warning("[orwell] belt-state restore failed part-way", exc_info=True)
    return n

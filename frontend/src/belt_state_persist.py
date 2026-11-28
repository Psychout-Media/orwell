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
_SEQ_LOCK = threading.Lock()
_SEQ = 0  # snapshot sequence; a write of an older snapshot never lands over a newer one
_WRITTEN_SEQ = 0
_TIMER: "threading.Timer | None" = None

# The agent_loop int-valued stores, by attribute name.
_INT_STORES = (
    "_TURNS_SINCE_PROGRESS", "_ADVANCE_STALL_LEVEL", "_ADVANCE_STALL_FLAGS",
    "_SILENT_FORCE_ADVANCE_STREAK", "_ANTI_STALE_CAP_HOLDS", "_RECAP_VOICED_DAY",  # ORW-1155
)
_REGROUND_STORE = "_DESYNC_REGROUND"

# ORW-399: the chat_helpers pacing stores, by attribute name -> value kind. Keys are runway keys (str).
#   "hold"  = (sig:str, n:int)   "int" = int   "bool" = bool   "str" = str   "strlist" = list[str]
_PACING_DICTS = {
    "_PRODUCTION_HOLD": "hold", "_PREMIERE_MSGS": "int", "_PREMIERE_CLOCK_HOLD": "bool",
    "_PREMIERE_TOAST_SPEAKERS": "strlist", "_PREMIERE_ENTRANCE_STAGE": "str", "_COMP_PAUSED": "str",
}
_PACING_SET = "_PREMIERE_CLOCK_STARTED"  # a set of runway keys
_FOLD_REQUIRED = ("content", "with_ids", "kind", "idempotency_key", "consequence", "felt_minutes", "row_anchor")  # every key `fold_ledger._make_entry` writes; settle and truncate read them unconditionally


def _stores():
    """(agent_loop int stores by name, the re-ground dict). Imported lazily: both modules import heavily."""
    from src import agent_loop
    from routes import chat_helpers
    return {n: getattr(agent_loop, n) for n in _INT_STORES}, getattr(chat_helpers, _REGROUND_STORE)


def _pacing_stores():
    """(chat_helpers pacing dicts by name, the premiere-clock-started set)."""
    from routes import chat_helpers
    return {n: getattr(chat_helpers, n) for n in _PACING_DICTS}, getattr(chat_helpers, _PACING_SET)


def _snapshot_pacing() -> dict:
    dicts, started = _pacing_stores()
    out: dict = {}
    for name, store in dicts.items():
        kind = _PACING_DICTS[name]
        saved: dict = {}
        for k, v in dict(store).items():
            if kind == "hold":
                saved[str(k)] = [str(v[0]), int(v[1])]
            elif kind == "int":
                saved[str(k)] = int(v)
            elif kind == "bool":
                saved[str(k)] = bool(v)
            elif kind == "strlist":
                saved[str(k)] = [str(x) for x in v]
            else:
                saved[str(k)] = str(v)
        out[name] = saved
    out[_PACING_SET] = sorted(str(k) for k in set(started))
    return out


def _snapshot_folds() -> list:
    """The fold ledger's pending queues as [{owner, session_id, entries}]: the staged payloads are
    Vault-free (roster-checked ids, closed-enum kind, truncated content) and carry their idempotency key,
    so a settle after a restart is the same single settle the engine already dedups."""
    from src import fold_ledger
    return [{"owner": k[0], "session_id": k[1], "entries": [dict(e) for e in list(q)]}  # list(q) / dict(...) are single C-level copies: no half-mutated queue
            for k, q in list(dict(fold_ledger._PENDING).items()) if q]


def snapshot() -> dict:
    ints, reground = _stores()
    return {
        "v": 1,
        "ints": {n: {str(k): int(v) for k, v in dict(s).items()} for n, s in ints.items()},
        "reground": {str(k): str(v) for k, v in dict(reground).items() if v},
        "pacing": _snapshot_pacing(),
        "folds": _snapshot_folds(),
    }


def prepare_save() -> tuple:
    """Take a snapshot NOW, on the caller's thread, and return it for `save_now(prepared)`. The fold ledger's
    mutators run on the event loop under no lock, so a caller that offloads the fsync'd write to a worker
    thread (the truncate route) snapshots here, on the loop, where the ledger cannot change mid-copy (review of #2751)."""
    global _SEQ
    with _SEQ_LOCK:
        _SEQ += 1
        return (_SEQ, snapshot())


def save_now(prepared: "tuple | None" = None) -> None:
    """Write the current stores to disk (or the snapshot from `prepare_save`, skipped if a newer one was
    already written). Never raises."""
    global _WRITTEN_SEQ
    try:
        with _LOCK:
            seq, snap = prepared if prepared is not None else prepare_save()
            if seq < _WRITTEN_SEQ:
                return
            atomic_write_json(str(BELT_STATE_PATH), snap, indent=2)
            _WRITTEN_SEQ = seq
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
        n += _restore_pacing(data.get("pacing"))
        n += _restore_folds(data.get("folds"))
    except Exception:  # failsoft-ok: restore is best-effort; whatever was applied stands, startup continues
        logger.warning("[orwell] belt-state restore failed part-way", exc_info=True)
    return n


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _pacing_value(kind: str, v):
    """The validated value for one saved pacing entry, or None when malformed."""
    if kind == "hold":
        return (v[0], v[1]) if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str) and _is_int(v[1]) else None
    if kind == "int":
        return v if _is_int(v) else None
    if kind == "bool":
        return v if isinstance(v, bool) else None
    if kind == "strlist":
        return list(v) if isinstance(v, list) and all(isinstance(x, str) for x in v) else None
    return v if isinstance(v, str) else None


def _restore_pacing(saved) -> int:
    if not isinstance(saved, dict):
        return 0
    dicts, started = _pacing_stores()
    n = 0
    for name, store in dicts.items():
        entries = saved.get(name)
        if store or not isinstance(entries, dict):
            continue
        for k, v in entries.items():
            val = _pacing_value(_PACING_DICTS[name], v)
            if isinstance(k, str) and val is not None:
                store[k] = val
                n += 1
    keys = saved.get(_PACING_SET)
    if not started and isinstance(keys, list):
        for k in keys:
            if isinstance(k, str):
                started.add(k)
                n += 1
    return n


def _valid_fold_entry(e) -> bool:
    return (isinstance(e, dict) and all(k in e for k in _FOLD_REQUIRED)
            and isinstance(e["content"], str) and isinstance(e["kind"], str)
            and isinstance(e["idempotency_key"], str) and e["idempotency_key"]
            and isinstance(e["with_ids"], list) and all(isinstance(x, str) for x in e["with_ids"])
            # review of #2751: the nullable fields are checked for SHAPE too, not only presence. A JSON object for `row_anchor` would reach a DB equality at settle/truncate outside its handler
            and (e["row_anchor"] is None or isinstance(e["row_anchor"], str))
            and (e["consequence"] is None or isinstance(e["consequence"], dict))
            and (e["felt_minutes"] is None or _is_int(e["felt_minutes"]))
            and all(e.get(k) is None or isinstance(e.get(k), dict) for k in ("assurance", "heard_about_me", "promise", "statement"))
            and (e.get("actor") is None or isinstance(e.get("actor"), str)))


def _restore_folds(saved) -> int:
    """Reload staged folds into an EMPTY ledger (never overwrites live state). A malformed entry is skipped."""
    from src import fold_ledger
    if fold_ledger._PENDING or not isinstance(saved, list):
        return 0
    n = 0
    for item in saved:
        if not isinstance(item, dict) or not isinstance(item.get("entries"), list):
            continue
        owner, sid = item.get("owner"), item.get("session_id")
        if not (owner is None or isinstance(owner, str)) or not (sid is None or isinstance(sid, str)):
            continue
        good = [e for e in item["entries"] if _valid_fold_entry(e)]
        if good:
            fold_ledger._PENDING[(owner, sid)] = good[-fold_ledger._MAX_QUEUE_LEN:]
            n += len(good)
    return n

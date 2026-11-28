"""ORW-1156 part 3 - every intent gate logs its decision.

The error class: a gate (a regex, a pre-filter, a cue, a veto) decides "this message asks for nothing", is wrong, and reports nothing; the narration then states the change anyway. Each gate now calls
`decide(gate, fired, reason)`: one INFO line (`[gate] gate=.. decision=.. reason=..  msg=<code>`) and a counter. The message is only ever a short hash code (never the text), and one message counts once per
gate (a message is asked the same gate several times in a turn). `stats()` is on /api/admin/health as `gates`; the miss rates per gate come from the labelled corpus (`src/gate_corpus.py`).
Pure, thread-safe, fail-open: a logging fault never changes a gate's answer.
"""
from __future__ import annotations

import hashlib
import logging
import threading
from collections import OrderedDict, deque
from typing import Any

logger = logging.getLogger(__name__)

GATES = (
    "bed-intent",  # agent_loop._player_means_going_to_bed: the player's own sleep act
    "act-first-prefilter",  # act_first.prefilter: empty / out-of-character, the model is not asked
    "act-first-no-cue",  # act_first.decide: no cue and no plain act in the words, the model is not asked
    "act-first-ungrounded",  # act_first.can_commit_nothing: every call would be rejected, so noAction by construction
    "act-first-accept",  # act_first.accept_intent: a plain yes to a standing invitation (ORW-1174)
    "act-first-plain-acts",  # act_first.plain_acts: the plain words commit an act without the model
    "search-cue",  # act_first.search_cue: a houseguest named in the words with search offered
    "move-veto",  # act_first.room_vetoed: a precision veto on a move
    "bed-veto",  # act_first.bed_vetoed
    "step-veto",  # act_first.step_vetoed
    "belt-want-record", "belt-want-move", "belt-want-npc-move", "belt-want-advance", "belt-want-promise", "belt-want-approach",  # agent_gates.want_*: the fold / record / move belts
)
_LOCK = threading.Lock()
_COUNTS: "dict[str, dict[str, int]]" = {g: {"fired": 0, "skipped": 0} for g in GATES}
_SEEN: "OrderedDict[tuple, bool]" = OrderedDict()
_SEEN_MAX = 2048
_RING: "deque[dict]" = deque(maxlen=300)


def code_of(text: Any) -> str:
    """A short stable code for a message: enough to join a decision to a corpus row, impossible to read back."""
    return hashlib.sha1(str(text or "").encode("utf-8", "ignore")).hexdigest()[:10]


def decide(gate: str, fired: bool, reason: str = "", msg: Any = None) -> bool:
    """Log and count one gate decision; returns `fired` unchanged so a gate can `return decide(...)`. `msg` is hashed, never stored."""
    try:
        code = code_of(msg) if msg is not None else ""
        with _LOCK:
            if code:
                key = (code, gate)
                if key in _SEEN:
                    _SEEN.move_to_end(key)
                    return fired
                _SEEN[key] = True
                while len(_SEEN) > _SEEN_MAX:
                    _SEEN.popitem(last=False)
            c = _COUNTS.setdefault(gate, {"fired": 0, "skipped": 0})
            c["fired" if fired else "skipped"] += 1
            _RING.append({"gate": gate, "fired": bool(fired), "reason": str(reason)[:40], "msg": code})
        logger.info("[gate] gate=%s decision=%s reason=%s msg=%s", gate, "fire" if fired else "skip", reason or "-", code or "-")
    except Exception:  # failsoft-ok: a log line never changes a gate's answer
        pass
    return fired


_CTX: "OrderedDict[str, dict]" = OrderedDict()
_CTX_MAX = 500


def note_ctx(msg: Any, *, people=(), rooms=(), here: Any = None, offered: Any = None) -> None:
    """ORW-1185/1186: the LIVE context a gate saw for one message, kept beside its code so the corpus replays the gate exactly (the offline run has no roster and guesses names from capital letters).
    Holds the houseguests' first names (the public roster), room ids, the player's room and the offered tool kinds: never any of the player's words. Fail-open, bounded."""
    try:
        code = code_of(msg)
        row = {"people": sorted({str(n).split()[0].lower() for n in (people or []) if str(n).split()})[:40], "rooms": [str(r) for r in (rooms or [])][:40],
               "here": str(here) if here else None, "offered": sorted(str(k) for k, v in (offered or {}).items() if v)[:12]}
        with _LOCK:
            _CTX[code] = row
            _CTX.move_to_end(code)
            while len(_CTX) > _CTX_MAX:
                _CTX.popitem(last=False)
    except Exception:  # failsoft-ok: a log line never changes a gate's answer
        pass


def ctx_of(code: str) -> "dict | None":
    with _LOCK:
        return dict(_CTX[code]) if code in _CTX else None


def ctx_export() -> "dict[str, dict]":
    with _LOCK:
        return {k: dict(v) for k, v in _CTX.items()}


def stats() -> "dict[str, Any]":
    with _LOCK:
        by = {g: dict(v) for g, v in _COUNTS.items()}
        recent = list(_RING)[-20:]
    return {"byGate": by, "decisions": sum(v["fired"] + v["skipped"] for v in by.values()), "recent": recent, "corpus": _corpus_section(), "ctxCodes": len(_CTX)}


def _corpus_section() -> Any:
    try:
        from src import gate_corpus
        return gate_corpus.miss_report()
    except Exception:  # failsoft-ok: the admin page shows the counters without the corpus
        return None


def reset() -> None:
    with _LOCK:
        for v in _COUNTS.values():
            v["fired"] = v["skipped"] = 0
        _SEEN.clear()
        _RING.clear()
        _CTX.clear()


def logged(gate: str, *, msg_index: int = 0, fired=bool, reason=None):
    """Decorator: log a pure gate's decision without changing its answer. `fired(result)` is True when the gate says an act IS asked (for a skip-style gate, the inverse of its skip). The message is
    the positional argument `msg_index`; a gate with no message (a belt nudge gate) uses msg_index=-1."""
    import functools

    def wrap(fn):
        @functools.wraps(fn)
        def inner(*a, **k):
            r = fn(*a, **k)
            try:
                decide(gate, bool(fired(r)), reason(r) if reason else "", msg=(a[msg_index] if 0 <= msg_index < len(a) else None))
            except Exception:  # failsoft-ok: a log line never changes a gate's answer
                pass
            return r
        return inner
    return wrap

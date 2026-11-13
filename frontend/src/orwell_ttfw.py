"""ORW-223 part C, slice C2 - time-to-first-word (TTFW) logging. Always on, fail-soft, near zero cost.

The agent loop stamps when it starts handling a narrated game turn and when the first non-empty narrator delta (reasoning excluded)
reaches the consumer. ``ttfw_ms`` goes into a bounded in-memory ring and one JSONL line per narrated turn.

JSONL line (``<DATA_DIR>/ttfw.jsonl``, append-only, ids / ints ONLY - no narration, no names)::

    {"ts": float epoch, "sid": 10-hex sha1 of the session id | null, "ttfw_ms": int}

Nothing here can affect a turn: every failure is swallowed.
"""
from __future__ import annotations

import contextvars
import hashlib
import json
import logging
import os
import threading
import time
from collections import deque
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

RING_MAX = 200

_RING: "deque[dict]" = deque(maxlen=RING_MAX)
_LOCK = threading.Lock()
CURRENT: "contextvars.ContextVar[Optional[TurnRecord]]" = contextvars.ContextVar("ttfw_turn", default=None)


def jsonl_path() -> str:
    """``ORWELL_TTFW_FILE`` (tests / a custom spot) else ``<DATA_DIR>/ttfw.jsonl``."""
    p = os.environ.get("ORWELL_TTFW_FILE")
    if p:
        return p
    from src.constants import DATA_DIR
    return os.path.join(DATA_DIR, "ttfw.jsonl")


def ring() -> list:
    with _LOCK:
        return list(_RING)


def clear_ring() -> None:
    with _LOCK:
        _RING.clear()


class TurnRecord:
    """One turn's stamps. ``clock`` is injectable (monotonic seconds) so TTFW is testable."""

    def __init__(self, session_id: Any = None, clock: Callable[[], float] = time.monotonic) -> None:
        self.clock = clock
        self.session_id = session_id
        self.t_turn_start: float = clock()
        self.t_first_word: Optional[float] = None

    def first_word(self) -> None:
        if self.t_first_word is None:
            self.t_first_word = self.clock()

    @property
    def ttfw_ms(self) -> Optional[int]:
        if self.t_first_word is None:
            return None
        return max(0, int(round((self.t_first_word - self.t_turn_start) * 1000)))

    def line(self) -> dict:
        return {
            "ts": round(time.time(), 3),
            "sid": _hash(self.session_id),
            "ttfw_ms": self.ttfw_ms,
        }


def _hash(v: Any) -> Optional[str]:
    if v is None or v == "":
        return None
    return hashlib.sha1(str(v).encode("utf-8", "replace")).hexdigest()[:10]


def begin_turn(session_id: Any = None, clock: Callable[[], float] = time.monotonic) -> tuple:
    """-> (record, token). Binds the record to this task's context; ``end_turn`` resets it."""
    rec = TurnRecord(session_id, clock)
    return rec, CURRENT.set(rec)


def note_stream_event(rec: Optional[TurnRecord], evt: Any) -> None:
    """Stamp the first narrator DELTA with non-empty text (reasoning excluded) - what the player first sees. Cheap after the first hit."""
    if rec is None or rec.t_first_word is not None or not isinstance(evt, str) or '"delta"' not in evt:
        return
    try:
        body = evt[evt.index("{"):evt.rindex("}") + 1] if "{" in evt else ""
        data = json.loads(body)
        d = data.get("delta") if isinstance(data, dict) else None
        if isinstance(d, str) and d.strip() and not data.get("thinking"):
            rec.first_word()
    except Exception:  # failsoft-ok: instrumentation must never touch the stream
        return


def end_turn(rec: Optional[TurnRecord], token: Any = None) -> Optional[dict]:
    """Write the turn line (ring + JSONL) if the turn was narrated. Never raises."""
    line = None
    try:
        if rec is not None and rec.t_first_word is not None:
            line = rec.line()
            with _LOCK:
                _RING.append(line)
            try:
                path = jsonl_path()
                os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
                with open(path, "a", encoding="utf-8") as f:
                    f.write(json.dumps(line, separators=(",", ":")) + "\n")
            except Exception as e:  # failsoft-ok: a full disk must not hurt the turn
                logger.debug("ttfw: jsonl write failed: %s", e)
    except Exception as e:  # failsoft-ok
        logger.debug("ttfw: end_turn failed: %s", e)
    try:
        if token is not None:
            CURRENT.reset(token)
    except Exception:  # failsoft-ok: reset from a different context (generator closed elsewhere)
        pass
    return line

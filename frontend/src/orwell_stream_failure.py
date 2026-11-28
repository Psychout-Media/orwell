"""ORW-1143: what happens when the chat_stream generator fails (prod 2026-11-28: a reply never came and nobody was told).

One call, `handle(user, session, exc)`: the player gets a neutral retryable error (the caller builds the frame from NEUTRAL_MESSAGE), the turn is accounted once as a failed ledger row
(driver=error), the first failure per session per 15 minutes raises the ops alert, and a commit made earlier in the turn is flagged so the Retry narrates it without a second commit.
Nothing here reads or stores chat text: the alert carries the error class and the session id only. Never raises."""
from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from typing import Any

logger = logging.getLogger(__name__)

NEUTRAL_MESSAGE = "Something interrupted the show before the reply came through. Your message was received. Press Retry to continue."
ALERT_INTERVAL_S = 900.0
_LOCK = threading.Lock()
_ALERTED: dict[str, float] = {}


def _alert_due(session: Any, now: float) -> bool:
    sid = str(session or "-")
    with _LOCK:
        last = _ALERTED.get(sid)
        if last is not None and now - last < ALERT_INTERVAL_S:
            return False
        _ALERTED[sid] = now
        for k in [k for k, t in _ALERTED.items() if now - t >= ALERT_INTERVAL_S]:
            _ALERTED.pop(k, None)
        return True


def reset() -> None:
    with _LOCK:
        _ALERTED.clear()


def handle(user: Any, session: Any, exc: BaseException, *, rows_before: int | None = None, live_game: bool = True) -> bool:
    """Returns True when this call raised the alert. `rows_before` is `recorded_count + unledgered_count` read when the turn began: a row written since (the agent loop's own) is not doubled."""
    alerted = False
    try:
        from src import act_first as _af
        _af.mark_turn_failed(user)
    except Exception:  # failsoft-ok: the memo is an extra
        pass
    try:
        if live_game and user:
            from src import orwell_sync_ledger as _led
            if rows_before is None or (_led.recorded_count(user) + _led.unledgered_count(user)) == rows_before:
                _led.record_unledgered_turn(user, session=session, reason="failed")
    except Exception:  # failsoft-ok: stream-failure-accounting - the failure itself is already logged with its traceback by the caller; the row is telemetry
        logger.warning("[orwell] stream-failure ledger row could not be written (session %s)", session)
    try:
        if _alert_due(session, time.monotonic()):
            from src import log_rings
            # the class name and the session id only: an exception message can carry text from the turn
            log_rings.record_soft_failure("chat-stream:generator-failed", f"{type(exc).__name__} session={session}", user=user)
            logger.error("[orwell] ALERT chat_stream generator failed class=%s session=%s", type(exc).__name__, session)
            alerted = True
    except Exception:  # failsoft-ok: stream-failure-alert - the ERROR log line above carries the class and session; the alert hook itself is down
        logger.warning("[orwell] stream-failure alert could not be raised (session %s)", session)
    return alerted


def _frame(error: str, status: int, **extra) -> str:
    return f'event: error\ndata: {json.dumps({"error": error, "status": status, "terminal": True, **extra})}\n\n'


async def guard_stream(stream_factory, *, session: Any, user: Any, live_game: bool = True, on_finish=None):
    """Wrap the turn's SSE producer so it ALWAYS ends in a typed terminal chunk: an exception out of the generator, or a normal exit that never emitted ``[DONE]``, becomes a clean
    ``event: error`` (neutral text, `retry: true`) plus ``[DONE]`` on the wire, instead of the body dropping. A body that ends with no ``[DONE]`` reads in the browser as a network drop and
    triggers its auto-recovery; ending cleanly removes that trigger at the source. A client disconnect (cancel / generator exit) is re-raised untouched: the detached run lives on."""
    saw_done = False
    rows_before = None
    try:
        from src import orwell_sync_ledger as _led
        rows_before = _led.recorded_count(user) + _led.unledgered_count(user)
    except Exception:  # failsoft-ok: accounting only
        pass
    try:
        async for chunk in stream_factory():
            if chunk == "data: [DONE]\n\n":
                saw_done = True
            yield chunk
    except (asyncio.CancelledError, GeneratorExit):
        raise
    except Exception as e:  # noqa: BLE001 - convert ANY generator failure into a surfaced, retryable error
        logger.exception("chat_stream generator failed (session %s)", session)
        handle(user, session, e, rows_before=rows_before, live_game=live_game)
        if not saw_done:
            yield _frame(NEUTRAL_MESSAGE, 500, retry=True, code="turn-failed")
            yield "data: [DONE]\n\n"
            saw_done = True
    finally:
        if on_finish is not None:
            try:
                on_finish()
            except Exception:  # pragma: no cover
                pass
    if not saw_done:
        # The generator returned without ever emitting [DONE] (an empty / dropped upstream stream): close the body with a typed terminal.
        yield _frame("The stream ended without a reply.", 502, retry=True)
        yield "data: [DONE]\n\n"

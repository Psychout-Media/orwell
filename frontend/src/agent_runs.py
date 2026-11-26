"""Detached agent-run manager.

Keeps an agent/chat stream running server-side after the SSE client disconnects
(tab close, navigate away, refresh). The streaming generator is drained by a
background asyncio task into a per-session replay buffer; SSE clients SUBSCRIBE
to that buffer (replay everything so far, then live). Closing the SSE only drops
the subscriber — the drain task keeps going.

The wrapped generator already persists the assistant message to the session on
completion, so reopening the session shows the finished result even if nobody
was connected when it finished. Reconnecting mid-run replays the buffer + streams
live (pick up where it is).

Durability scope: in-memory, survives as long as the server process runs (tab
close / navigation / refresh). It does NOT survive a server restart.
"""
import asyncio
import json
import logging
import os
import time
from typing import AsyncGenerator, Callable, Dict, Optional

logger = logging.getLogger(__name__)

# Monotonic per-process suffix for run ids (the creation stamp alone could collide on a fast
# double-start within one millisecond).
_RUN_ID_COUNTER = 0


def _next_run_id() -> str:
    """A stable, per-run identity marker (#1087 reconcile-by-id). Creation stamp + counter so it is
    unique within the process AND across a server restart (the counter alone would reset and let a
    client's remembered id falsely match a new run). Opaque to clients — compared, never parsed."""
    global _RUN_ID_COUNTER
    _RUN_ID_COUNTER += 1
    return f"{int(time.time() * 1000):x}-{_RUN_ID_COUNTER:x}"


class _Run:
    __slots__ = ("buffer", "subscribers", "status", "task", "evict_task", "run_id")

    def __init__(self) -> None:
        self.buffer: list = []          # ordered SSE event strings (replay log)
        self.subscribers: set = set()   # one asyncio.Queue per connected client
        self.status: str = "running"    # running | done | error | stopped
        self.task: Optional[asyncio.Task] = None
        self.evict_task: Optional[asyncio.Task] = None
        self.run_id: str = _next_run_id()  # #1087: reconcile-by-id for at-least-once run-started edges


_RUNS: Dict[str, _Run] = {}

# How long a FINISHED run (and its full replay buffer) is retained after the
# last subscriber disconnects, so a reconnect within the window can still
# replay the result. After this, the run is evicted to bound memory — without
# it, every session that ever streamed kept its entire event log forever.
#
# Operators tune this streamed-buffer retention window with ORWELL_EVICT_GRACE_S
# (seconds) — ADR 0012 #7 — read per-use so a change takes effect on the next
# eviction without a restart. Unset / blank / unparseable ⇒ the 180 s default, so
# the default path is byte-identical to the previous hard-coded constant.
_DEFAULT_EVICT_GRACE_S = 180


def _evict_grace_s() -> float:
    """The terminal-run buffer-retention grace, in seconds (ADR 0012 #7).

    Reads ORWELL_EVICT_GRACE_S from the environment on every call (mirroring the
    other per-use ORWELL_* FE settings) so operators can tune the retention window
    without a code change; an unset / blank / non-numeric value falls back to the
    180 s default, leaving default behavior unchanged."""
    raw = os.getenv("ORWELL_EVICT_GRACE_S")
    if raw is None or not raw.strip():
        return _DEFAULT_EVICT_GRACE_S
    try:
        return float(raw)
    except (TypeError, ValueError):
        return _DEFAULT_EVICT_GRACE_S


def _safe_cancel(task: Optional["asyncio.Task"]) -> None:
    """Cancel a task, tolerating one whose event loop has already closed.

    A drain/evict task can outlive the loop it was created on (e.g. a per-test ``_run`` loop that
    closed with the 180s evict timer still pending). Cancelling such a cross-loop task reaches into
    the dead loop and raises ``RuntimeError: Event loop is closed``. That is pure teardown noise —
    the loop is gone, nothing is running — so swallow it. In production the loop never closes, so
    this only ever takes the plain ``cancel()`` path (no behavior change)."""
    if task is None or task.done():
        return
    try:
        task.cancel()
    except RuntimeError:
        pass


def _publish(run: _Run, ev: str) -> None:
    """Append one SSE event and fan it out to every live subscriber."""
    run.buffer.append(ev)
    seq = len(run.buffer) - 1
    for q in list(run.subscribers):
        try:
            q.put_nowait((seq, ev))
        except Exception:
            pass


def _schedule_evict(session_id: str, run: Optional["_Run"] = None) -> None:
    """(Re)arm a grace-period eviction for a terminal run with no subscribers.
    Identity-checked so a run that gets replaced/reused is never evicted by a
    stale timer."""
    if run is None:
        run = _RUNS.get(session_id)
    if run is None:
        return
    _safe_cancel(run.evict_task)

    async def _evict(run_ref: _Run) -> None:
        try:
            await asyncio.sleep(_evict_grace_s())
        except asyncio.CancelledError:
            return
        cur = _RUNS.get(session_id)
        if cur is run_ref and cur.status != "running" and not cur.subscribers:
            _RUNS.pop(session_id, None)

    run.evict_task = asyncio.create_task(_evict(run))


def is_active(session_id: str) -> bool:
    r = _RUNS.get(session_id)
    return bool(r and r.status == "running")


def has_run(session_id: str) -> bool:
    """True if a run EXISTS for this session — running OR terminal-but-still-buffered (within the
    evict grace). Distinct from is_active (running only): the Messenger-mirror late-attach
    (ADR 0012) needs a peer to RESUME and REPLAY a run that JUST finished — a short turn often
    completes before a peer's `run-started`→resume chain arrives, so gating resume on `is_active`
    404s the very window that should be mirroring it. `subscribe()` replays the buffer then ends for
    a finished run, so resuming an existing-but-terminal run is safe and idempotent (reconcile-by-id)."""
    return _RUNS.get(session_id) is not None


def run_id(session_id: str) -> Optional[str]:
    """The current run's stable identity marker, or None when no run exists (evicted / never ran).
    #1087: `session_events`' replay ring re-delivers a finished run's `run-started` invitation
    at-least-once; the WS transport stamps this id onto the `run-started` state edge and the chat
    subscribe ack so a client can reconcile-by-id and ignore an edge for a run it already rendered
    (the `_chatTailActive` boolean alone cannot — the finished run's `done` cleared it)."""
    run = _RUNS.get(session_id)
    return run.run_id if run is not None else None


def head_seq(session_id: str) -> int:
    """The current buffer head index (the last replayable `seq`), or -1 when the run has no buffered
    event yet / does not exist. This is the SAME index `_publish` binds each event to
    (``seq = len(buffer) - 1``) — the WebSocket `chat` subscribe (WS Phase-1, §3.1) reports it as the
    `ack`'s `headSeq` so the client knows the exact ``[fromSeq..headSeq]`` window the replay covers
    before the live tail begins. Read once, right before subscribe; a live append after is fine — the
    replay-then-tail contract stays contiguous regardless (headSeq is advisory)."""
    run = _RUNS.get(session_id)
    if run is None:
        return -1
    return len(run.buffer) - 1


def get_status(session_id: str) -> Optional[str]:
    r = _RUNS.get(session_id)
    return r.status if r else None


async def _drain(session_id: str, agen: AsyncGenerator[str, None],
                 prev_task: Optional[asyncio.Task] = None, run: Optional["_Run"] = None) -> None:
    """Pull every event from the wrapped generator into the run buffer, fanning
    each out to live subscribers. Runs to completion regardless of subscribers."""
    # ORW-814: the run is BOUND by start(), never looked up here. This coroutine first executes on a later loop tick; if a second turn start()ed in between (rapid sends, three
    # unanswered then a fourth), `_RUNS.get(session_id)` returned the NEWEST run, so this older run's reply was published into the newer run's buffer (the reply landed under the wrong
    # turn) and its status/sentinel were applied to the wrong run. `run` is None only for a legacy direct caller.
    if run is None:
        run = _RUNS.get(session_id)
    if run is None:
        return
    if _RUNS.get(session_id) is not run:
        logger.info("[agent-run] run %s on %s was superseded before it first ran (queued behind another turn)", run.run_id, session_id)
    # If this run replaced an in-flight one (rapid double-send), wait for that
    # one to fully finish first. Its CancelledError handler calls aclose(), which
    # persists its partial response — letting it complete before we start writing
    # keeps the two runs' session saves sequential instead of interleaved.
    if prev_task is not None and not prev_task.done():
        _t0 = time.monotonic()
        try:
            await asyncio.wait({prev_task})
        except asyncio.CancelledError:
            raise            # our own cancellation — propagate
        except Exception:
            pass
        logger.info("[agent-run] run %s on %s started after waiting %.0f ms behind the previous turn", run.run_id, session_id, (time.monotonic() - _t0) * 1000)
    try:
        async for ev in agen:
            _publish(run, ev)
        if run.status == "running":
            run.status = "done"
    except asyncio.CancelledError:
        run.status = "stopped"
        # Let the wrapped generator's own CancelledError handler run (it saves
        # the partial response to the session).
        try:
            await agen.aclose()
        except Exception:
            pass
    except Exception as e:
        logger.error("[agent-run] %s failed: %s", session_id, e, exc_info=True)
        run.status = "error"
        _publish(
            run,
            "event: error\n"
            f"data: {json.dumps({'error': 'Agent run failed before completion.', 'status': 500})}\n\n",
        )
        _publish(run, "data: [DONE]\n\n")
    finally:
        # Wake every subscriber with the end sentinel so their SSE closes.
        for q in list(run.subscribers):
            try:
                q.put_nowait((None, None))
            except Exception:
                pass
        # Run is terminal — arm the grace timer so it (and its buffer) is
        # eventually freed even if nobody ever reconnects. subscribe() cancels
        # this on connect and re-arms on disconnect.
        _schedule_evict(session_id, run)


def start(session_id: str, agen: AsyncGenerator[str, None], *, queue: bool = False,
          lead_event: Optional[str] = None, on_finish: Optional[Callable[[], None]] = None) -> _Run:
    """Start a detached run draining `agen` for a session.

    Default (plain chat): if a run is already in flight for this session (a rapid double-send), it is
    CANCELLED first and the new run replaces it.

    `queue=True` (feature 0064 Part C — the Messenger model for GAME turns): the in-flight run is NOT
    cancelled — the new run CHAINS after it (it awaits the current run's natural completion via the
    same `prev_task` wait, then drains). So a second device's game turn never STOMPS the one in
    flight; turns serialize, and there is never more than one reasoning chain at a time. The new run
    streams to its own subscribers only once the prior one ends. (Plain chats keep cancel-on-double-
    send — only the game path opts into queuing.)

    `lead_event` (F1 — concurrent-session consistency, the causal-inversion fix): an SSE event string
    SEEDED as the FIRST buffered event (`seq 0`) BEFORE any assistant delta. The live channel carries
    only the assistant reply; the prompting USER turn is not broadcast on it, so an observer/mirror
    window could render the reply before its cause. Leading the run buffer with the persisted user
    message (`{type:"user_message", id, seq, content, clientMsgId}`) makes replay-then-tail deliver
    cause-before-effect ATOMICALLY to every subscriber (WS `chat` channel and SSE resume alike). It is
    Vault-free — the player's own words. Seeded here synchronously, before the drain task is created,
    so it is guaranteed to occupy buffer index 0 (the drain cannot run until the next await). None ⇒
    byte-identical to the prior behavior (an empty buffer at start)."""
    prev = _RUNS.get(session_id)
    prev_task: Optional[asyncio.Task] = None
    if prev:
        if prev.task and not prev.task.done():
            if not queue:
                _safe_cancel(prev.task)  # plain chat: replace the in-flight run (the historical behavior)
            prev_task = prev.task    # new run awaits this — a CANCELLED stomp OR a queued natural finish
        _safe_cancel(prev.evict_task)
    run = _Run()
    _RUNS[session_id] = run
    # F1: seed the leading user-message event at buffer index 0 (cause before effect) BEFORE the drain
    # task exists, so no assistant delta can ever precede it in the replay buffer.
    if lead_event:
        _publish(run, lead_event)
    run.task = asyncio.create_task(_drain(session_id, agen, prev_task, run))
    if on_finish is not None:
        # ORW-491 admission hand-off hook: fires on EVERY end of this run's task (done, error, cancelled while queued or running, cancelled before its first step), exactly once.
        def _fin(_t: "asyncio.Task") -> None:
            try:
                on_finish()
            except Exception:  # noqa: BLE001 - a hook must never affect a run
                logger.warning("[agent-run] on_finish hook failed", exc_info=True)
        run.task.add_done_callback(_fin)
    return run


async def subscribe(session_id: str, from_seq: int = 0) -> AsyncGenerator[str, None]:
    """Replay the run's buffer from `from_seq`, then stream live until it ends.
    Safe to call repeatedly (reconnect) and from multiple clients at once.

    `from_seq` (WS Phase-1 §3.2 preferred path — back-compat: default 0 ⇒ byte-identical to the
    historical replay-from-0 → live-tail behavior every SSE subscriber uses today). A late/reconnecting
    client that already rendered through buffer index N passes `from_seq = N + 1` so the server replays
    ONLY `buffer[from_seq..len)` — the "give me everything after what I have" cursor — then live-tails,
    with no gap and no dup at the splice. It works because `next_seq` starts at `from_seq`: replay yields
    the buffered tail from there, and the live drain's de-dup (`if seq >= next_seq`) + sentinel flush are
    unchanged, so the yielded events stay contiguous buffer indices `from_seq, from_seq+1, …` regardless
    of when the drop happened. A `from_seq` past the current head simply replays nothing and live-tails
    from there (the caller is expected to clamp to the buffer; a negative value is floored to 0)."""
    run = _RUNS.get(session_id)
    if run is None:
        return
    q: asyncio.Queue = asyncio.Queue()
    run.subscribers.add(q)            # register BEFORE replaying so nothing is missed
    # A live subscriber is connected — don't let a pending grace timer evict
    # the run out from under it mid-replay.
    if run.evict_task and not run.evict_task.done():
        run.evict_task.cancel()
    try:
        next_seq = from_seq if from_seq > 0 else 0
        while next_seq < len(run.buffer):
            yield run.buffer[next_seq]
            next_seq += 1
        if run.status != "running":
            return
        while True:
            seq, ev = await q.get()
            if seq is None:            # end sentinel
                while next_seq < len(run.buffer):   # flush any tail the sentinel raced
                    yield run.buffer[next_seq]
                    next_seq += 1
                break
            if seq >= next_seq:        # skip events already replayed from the buffer
                yield ev
                next_seq = seq + 1
    finally:
        run.subscribers.discard(q)
        # Last subscriber gone on a finished run — (re)arm eviction so the
        # buffer doesn't linger indefinitely.
        if not run.subscribers and run.status != "running":
            _schedule_evict(session_id, run)


def stop(session_id: str) -> bool:
    """Cancel an in-flight run (the wrapped generator saves its partial)."""
    run = _RUNS.get(session_id)
    if run and run.task and not run.task.done():
        _safe_cancel(run.task)
        return True
    return False

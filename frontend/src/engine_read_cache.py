"""ORW-166: a short-TTL, per-user, single-flight cache for the HUD POLLER game-state reads.

Every panel's poll (`/api/orwell/state`, `/status`, `/roster`, `/knowledge`, `/dossier`) used to call the engine afresh, even a split second after
the identical question was answered (660 `/state` calls in 14 minutes on prod), queueing behind the narrator's own engine calls in the engine's
per-user queue. This module collapses that:

  * SINGLE-FLIGHT: concurrent identical reads for one user share ONE engine call.
  * SHORT TTL (default 400 ms): a read inside the window is served from memory.
  * INVALIDATED by any mutation: `orwell_engine._call` calls `invalidate(user)` before and after every tool that is not a known pure read, and an
    in-flight read that started before an invalidation is never stored or joined. Reads and invalidations are ordered on ONE process-wide tick
    counter that is never reused, so no cleanup can make an old read look fresh again (see `_sweep_locked`).
  * INVALIDATED on a `beatSeq` change: a stored result carrying a different `beatSeq` than the user's last-seen one drops that user's other entries.
  * PER USER, never across users: the key is (user, tool). Callers get a deep copy, so a handler that mutates its result cannot poison the cache.
  * VAULT-FREE: only the two Vault-free public projections (`getGameState`, `gameStatus`) are cacheable (`CACHEABLE`); nothing else is ever stored.
  * BOUNDED: cached entries AND the per-user bookkeeping (last invalidation, last-seen beat) are swept once any of them outgrows the bound.

Opt-in per call site (`orwell_engine.get_game_state_polled` / `game_status_polled`, used only by the poller routes): the chat-blocking framing
reads keep calling the engine directly so the narrator never reads state older than its own turn. Pure asyncio, no I/O of its own.
`ORWELL_STATE_CACHE_TTL_MS=0` disables it (every read goes to the engine).
"""
from __future__ import annotations

import asyncio
import copy
import itertools
import os
import threading
import time
from typing import Any, Awaitable, Callable

CACHEABLE = frozenset({"getGameState", "gameStatus"})
# Engine tools that never mutate game state: they must NOT invalidate the cache (the chat framing and the HUD pollers read them all the time).
# Anything NOT listed here is treated as a possible mutation and invalidates - over-invalidating is always safe, under-invalidating is the bug.
# Names are the real `_call("<tool>")` names in orwell_engine.py (a test pins that every one exists there): `getVisibleStateFor` is the player's
# own projection behind /knowledge and /dossier, `whereabouts` the presence read behind the two 25 s presence pollers.
PURE_READS = frozenset({
    "getGameState", "gameStatus", "getMomentPrompt", "stateDelta", "getVisibleStateFor", "whereabouts", "renderScene", "socialRead", "seasonRecap",
    "dailyRecap", "playerReceipts", "playerDossier", "playerTagline", "socialInitiatives", "worldSnapshotView", "npcVoice", "competitionStagingView", "openLedgerHere", "groupsAwaitingWords",
    "hallOfFame",  # 0208 B3: a read of the per-user hall; commits nothing
    "beatLog",  # ORW-439: the engine's per-bump cause log (diagnostic read; commits and bumps nothing)
    "pipelineCast",  # ORW-969: the full cast for the casting jobs (a read; the gate polls it, so it must not invalidate the cache or count as a mutation)
})


def _ttl_s() -> float:
    try:
        return max(0.0, float(os.environ.get("ORWELL_STATE_CACHE_TTL_MS", "400")) / 1000.0)
    except ValueError:
        return 0.4


def _ukey(user: str | None) -> str:
    return "" if user is None else str(user)


class _Entry:
    __slots__ = ("value", "t", "start")

    def __init__(self, value: Any, t: float, start: int):
        self.value, self.t, self.start = value, t, start


_ENTRIES: dict[tuple[str, str], _Entry] = {}
_INFLIGHT: dict[tuple, tuple[int, "asyncio.Future[Any]"]] = {}   # key -> (start tick, the shared engine call)
_INV: dict[str, int] = {}        # user -> tick of their latest invalidation
_BEAT: dict[str, Any] = {}       # user -> the beatSeq their last stored read carried
_TICK = itertools.count(1)       # ONE process-wide clock for read starts and invalidations; a tick is never handed out twice
_RETIRED = 0                     # the newest invalidation tick among RETIRED user records: stands in for every record no longer kept
# `invalidate` runs from every engine call, including background write-backs that may run on their own loop/thread (llm_core.run_isolated),
# so the shared dicts are only touched under this lock. It is never held across an await.
_LOCK = threading.Lock()
# `user=None` (auth off / single-player) is its own bucket under the key "": it never shares with a named user.
_MAX_USERS = 256                 # the cache is HUD-sized: past this many live users only the newest users' entries are kept
_SWEEP_AT = 4 * _MAX_USERS       # record count that triggers the next sweep (re-armed after each sweep, see `_maybe_sweep_locked`)


def _last_inv(u: str) -> int:
    return _INV.get(u, _RETIRED)


def _fresh(u: str, start: int) -> bool:
    """True when no invalidation for `u` landed after tick `start`: a read that began at `start` may be stored, joined or served."""
    return _last_inv(u) < start


def _sweep_locked() -> None:
    """Bound memory (caller holds `_LOCK`): drop expired entries, keep only the newest `_MAX_USERS` users' entries, then retire the per-user
    records (last invalidation, last-seen beat) of every user with nothing cached and no read in flight.

    Retiring a record must never make an old read look fresh (Greptile on #2265: dropping a generation counter reset it to 0, so a read that
    began before a mutation passed the check again and stored pre-mutation state). Ticks are never reused, and a retired user's last
    invalidation tick is folded into `_RETIRED`, which every record-less user is measured against: a read that began before that invalidation
    stays stale. Users still caching or reading are pinned to the floor they had, so raising it never costs them a miss."""
    global _RETIRED
    now, ttl = time.monotonic(), _ttl_s()
    for k in [k for k, e in _ENTRIES.items() if now - e.t >= ttl]:
        _ENTRIES.pop(k, None)
    users = {k[0] for k in _ENTRIES}
    if len(users) > _MAX_USERS:
        newest: set[str] = set()
        for _t, u in sorted(((e.t, k[0]) for k, e in _ENTRIES.items()), reverse=True):
            newest.add(u)
            if len(newest) == _MAX_USERS:
                break
        users = newest
        for k in [k for k in _ENTRIES if k[0] not in users]:
            _ENTRIES.pop(k, None)
    busy = users | {k[0] for k, (_s, task) in _INFLIGHT.items() if not task.done()}
    for u in busy:
        _INV.setdefault(u, _RETIRED)
    for u in [u for u in _INV if u not in busy]:
        _RETIRED = max(_RETIRED, _INV.pop(u))
    for u in [u for u in _BEAT if u not in busy]:
        _BEAT.pop(u, None)


def _maybe_sweep_locked() -> None:
    """Sweep once entries OR per-user records outgrow the bound. Re-armed at twice what survived, so a cache full of live users is swept
    O(1) amortized per call, never on every call."""
    global _SWEEP_AT
    if max(len(_ENTRIES), len(_INV), len(_BEAT)) > _SWEEP_AT:
        _sweep_locked()
        _SWEEP_AT = max(4 * _MAX_USERS, 2 * max(len(_ENTRIES), len(_INV), len(_BEAT)))


def invalidate(user: str | None) -> None:
    """A mutation touched `user`'s game: forget everything cached for them and stop in-flight reads from being stored or joined."""
    u = _ukey(user)
    with _LOCK:
        _INV[u] = next(_TICK)
        _BEAT.pop(u, None)
        for k in [k for k in _ENTRIES if k[0] == u]:
            _ENTRIES.pop(k, None)
        _maybe_sweep_locked()


def clear() -> None:
    """Test seam / admin reset: drop everything. A read still running from before the clear can never store its result."""
    global _RETIRED, _SWEEP_AT
    with _LOCK:
        _ENTRIES.clear()
        _INFLIGHT.clear()
        _INV.clear()
        _BEAT.clear()
        _RETIRED = next(_TICK)
        _SWEEP_AT = 4 * _MAX_USERS


def _note_beat_locked(u: str, value: Any, own_key: tuple[str, str]) -> None:
    beat = value.get("beatSeq") if isinstance(value, dict) else None
    if beat is None:
        return
    prev = _BEAT.get(u)
    if prev is not None and prev != beat:
        # the engine moved since another cached read: those entries describe a different beat
        for k in [k for k in _ENTRIES if k[0] == u and k != own_key]:
            _ENTRIES.pop(k, None)
    _BEAT[u] = beat


async def _lead(key: tuple[str, str], flight_key: tuple, u: str, start: int, fetch: Callable[[], Awaitable[Any]]) -> Any:
    """The ONE engine call behind a key. Runs as its own task so a cancelled caller (the request-timeout middleware, a client disconnect)
    never cancels the call out from under the followers sharing it."""
    try:
        value = await fetch()
    finally:
        with _LOCK:
            if _INFLIGHT.get(flight_key, (None, None))[1] is asyncio.current_task():
                _INFLIGHT.pop(flight_key, None)
    stored = copy.deepcopy(value)
    with _LOCK:
        if _fresh(u, start):  # no mutation landed for this user since the read began: safe to store
            _ENTRIES[key] = _Entry(stored, time.monotonic(), start)
            _note_beat_locked(u, value, key)
    return value


def peek(name: str, user: str | None, max_age_s: float = 30.0, fields: tuple | None = None) -> Any:
    """ORW-408: the already-cached answer for `name`/`user`, or None. Never fetches and never awaits, so a caller on the streaming path cannot be delayed by a slow engine.
    Served only while no invalidation (any engine write) landed since it was read and it is at most `max_age_s` old. `fields`: copy only those top-level keys of a dict answer
    (the streaming checker needs two, and a deep copy of the whole state per streamed chunk is avoidable CPU on the event loop)."""
    u = _ukey(user)
    with _LOCK:
        ent = _ENTRIES.get((u, name))
        if ent is None or not _fresh(u, ent.start) or (time.monotonic() - ent.t) > max_age_s:
            return None
        value = ent.value
        if fields is not None and isinstance(value, dict):
            value = {k: value[k] for k in fields if k in value}
    return copy.deepcopy(value)


def peek_status(name: str, user: str | None, max_age_s: float = 30.0, fields: tuple | None = None) -> "tuple[Any, str]":
    """ORW-408: like :func:`peek` but also says WHY a miss missed, for the pre-display counters: (value, "ok"), (None, "no-cache") when nothing is stored for the user
    (never read, or dropped by a write), or (None, "stale") when an entry exists but a write landed since it was read or it is older than `max_age_s`. Never fetches."""
    value = peek(name, user, max_age_s=max_age_s, fields=fields)
    if value is not None:
        return value, "ok"
    with _LOCK:
        return None, ("no-cache" if _ENTRIES.get((_ukey(user), name)) is None else "stale")


async def read(name: str, user: str | None, fetch: Callable[[], Awaitable[Any]], timeout_class: Any = None) -> Any:
    """ORW-396: in-flight calls are keyed by `timeout_class` too, so a read with a wider timeout never joins a tighter-timeout call (it would fail at the shorter bound).
    Stored entries stay shared across classes (a fresh answer is a fresh answer). Serve `name` for `user` from the cache, a shared in-flight call, or `fetch()`. Only CACHEABLE tools are ever stored."""
    ttl = _ttl_s()
    if name not in CACHEABLE or ttl <= 0:
        return await fetch()
    u = _ukey(user)
    key = (u, name)
    flight_key = (u, name, timeout_class)
    with _LOCK:
        ent = _ENTRIES.get(key)
        if ent is not None and _fresh(u, ent.start) and (time.monotonic() - ent.t) < ttl:
            hit, task = ent.value, None
        else:
            hit = None
            flight = _INFLIGHT.get(flight_key)
            if flight is not None and _fresh(u, flight[0]) and not flight[1].done():
                task = flight[1]
            else:
                _maybe_sweep_locked()
                start = next(_TICK)
                task = asyncio.ensure_future(_lead(key, flight_key, u, start, fetch))
                task.add_done_callback(lambda t: t.cancelled() or t.exception())  # mark retrieved: a failure nobody awaited must not log noise
                _INFLIGHT[flight_key] = (start, task)
    if task is None:
        return copy.deepcopy(hit)
    # shield: cancelling THIS caller (leader or follower) leaves the shared call running for everyone else
    return copy.deepcopy(await asyncio.shield(task))

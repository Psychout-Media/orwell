"""ORW-166: a short-TTL, per-user, single-flight cache for the HUD POLLER game-state reads.

Every panel's poll (`/api/orwell/state`, `/status`, `/roster`, `/knowledge`, `/dossier`) used to call the engine afresh, even a split second after
the identical question was answered (660 `/state` calls in 14 minutes on prod), queueing behind the narrator's own engine calls in the engine's
per-user queue. This module collapses that:

  * SINGLE-FLIGHT: concurrent identical reads for one user share ONE engine call.
  * SHORT TTL (default 400 ms): a read inside the window is served from memory.
  * INVALIDATED by any mutation: `orwell_engine._call` calls `invalidate(user)` before and after every tool that is not a known pure read, and an
    in-flight read that started before an invalidation is never stored or joined (a generation counter per user).
  * INVALIDATED on a `beatSeq` change: a stored result carrying a different `beatSeq` than the user's last-seen one drops that user's other entries.
  * PER USER, never across users: the key is (user, tool). Callers get a deep copy, so a handler that mutates its result cannot poison the cache.
  * VAULT-FREE: only the two Vault-free public projections (`getGameState`, `gameStatus`) are cacheable (`CACHEABLE`); nothing else is ever stored.

Opt-in per call site (`cached=True`): the chat-blocking framing reads keep calling the engine directly so the narrator never reads state older than
its own turn. Pure asyncio, no I/O of its own. `ORWELL_STATE_CACHE_TTL_MS=0` disables it (every read goes to the engine).
"""
from __future__ import annotations

import asyncio
import copy
import os
import time
from typing import Any, Awaitable, Callable

CACHEABLE = frozenset({"getGameState", "gameStatus"})
# Engine tools that never mutate game state: they must NOT invalidate the cache (the chat framing reads them every turn). Anything NOT listed here
# is treated as a possible mutation and invalidates - over-invalidating is always safe, under-invalidating is the bug.
PURE_READS = frozenset({
    "getGameState", "gameStatus", "getMomentPrompt", "stateDelta", "getVisibleState", "renderScene", "socialRead", "seasonRecap", "dailyRecap",
    "playerReceipts", "playerDossier", "playerTagline", "socialInitiatives", "worldSnapshotView", "npcVoice", "competitionStagingView",
})


def _ttl_s() -> float:
    try:
        return max(0.0, float(os.environ.get("ORWELL_STATE_CACHE_TTL_MS", "400")) / 1000.0)
    except ValueError:
        return 0.4


def _ukey(user: str | None) -> str:
    return "" if user is None else str(user)


class _Entry:
    __slots__ = ("value", "t", "gen")

    def __init__(self, value: Any, t: float, gen: int):
        self.value, self.t, self.gen = value, t, gen


_ENTRIES: dict[tuple[str, str], _Entry] = {}
_INFLIGHT: dict[tuple[str, str], tuple[int, "asyncio.Future[Any]"]] = {}
_GEN: dict[str, int] = {}
_BEAT: dict[str, Any] = {}
# `user=None` (auth off / single-player) is its own bucket under the key "": it never shares with a named user.
_MAX_USERS = 256   # idle-user sweep bound: the cache is HUD-sized, so past this the oldest users' entries are dropped


def _gen(u: str) -> int:
    return _GEN.get(u, 0)


def _sweep() -> None:
    """Bound memory: drop expired entries, and the oldest users' entries if there are somehow more than _MAX_USERS."""
    now, ttl = time.monotonic(), _ttl_s()
    for k in [k for k, e in _ENTRIES.items() if now - e.t >= ttl]:
        _ENTRIES.pop(k, None)
    users = {k[0] for k in _ENTRIES}
    if len(users) > _MAX_USERS:
        keep = {u for u, _ in sorted(((k[0], e.t) for k, e in _ENTRIES.items()), key=lambda x: -x[1])[:_MAX_USERS]}
        for k in [k for k in _ENTRIES if k[0] not in keep]:
            _ENTRIES.pop(k, None)
    if len(_GEN) > 4 * _MAX_USERS:
        for u in [u for u in _GEN if u not in users]:
            _GEN.pop(u, None)   # safe: no entry or flight for this user can survive a generation reset (both are dropped/keyed on gen)
        _INFLIGHT.clear()


def invalidate(user: str | None) -> None:
    """A mutation touched `user`'s game: forget everything cached for them and stop in-flight reads from being stored or joined."""
    u = _ukey(user)
    _GEN[u] = _gen(u) + 1
    _BEAT.pop(u, None)
    for k in [k for k in _ENTRIES if k[0] == u]:
        _ENTRIES.pop(k, None)


def clear() -> None:
    """Test seam / admin reset: drop everything."""
    _ENTRIES.clear()
    _INFLIGHT.clear()
    _GEN.clear()
    _BEAT.clear()


def _note_beat(u: str, value: Any, own_key: tuple[str, str]) -> None:
    beat = value.get("beatSeq") if isinstance(value, dict) else None
    if beat is None:
        return
    prev = _BEAT.get(u)
    if prev is not None and prev != beat:
        # the engine moved since another cached read: those entries describe a different beat
        for k in [k for k in _ENTRIES if k[0] == u and k != own_key]:
            _ENTRIES.pop(k, None)
    _BEAT[u] = beat


async def _lead(key: tuple[str, str], u: str, gen: int, fetch: Callable[[], Awaitable[Any]]) -> Any:
    """The ONE engine call behind a key. Runs as its own task so a cancelled caller (the request-timeout middleware, a client disconnect)
    never cancels the call out from under the followers sharing it."""
    try:
        value = await fetch()
    finally:
        if _INFLIGHT.get(key, (None, None))[1] is asyncio.current_task():
            _INFLIGHT.pop(key, None)
    if _gen(u) == gen:  # no mutation landed while we were fetching: safe to store
        _ENTRIES[key] = _Entry(copy.deepcopy(value), time.monotonic(), gen)
        _note_beat(u, value, key)
    return value


async def read(name: str, user: str | None, fetch: Callable[[], Awaitable[Any]]) -> Any:
    """Serve `name` for `user` from the cache, a shared in-flight call, or `fetch()`. Only CACHEABLE tools are ever stored."""
    ttl = _ttl_s()
    if name not in CACHEABLE or ttl <= 0:
        return await fetch()
    u = _ukey(user)
    key = (u, name)
    gen = _gen(u)
    now = time.monotonic()
    ent = _ENTRIES.get(key)
    if ent is not None and ent.gen == gen and (now - ent.t) < ttl:
        return copy.deepcopy(ent.value)
    flight = _INFLIGHT.get(key)
    if flight is not None and flight[0] == gen and not flight[1].done():
        task = flight[1]
    else:
        if len(_ENTRIES) > 4 * _MAX_USERS:
            _sweep()
        task = asyncio.ensure_future(_lead(key, u, gen, fetch))
        task.add_done_callback(lambda t: t.cancelled() or t.exception())  # mark retrieved: a failure nobody awaited must not log noise
        _INFLIGHT[key] = (gen, task)
    # shield: cancelling THIS caller (leader or follower) leaves the shared call running for everyone else
    return copy.deepcopy(await asyncio.shield(task))

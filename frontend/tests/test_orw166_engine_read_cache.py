"""ORW-166 - the HUD-poller game-state read cache: single-flight, short TTL, per user, invalidated by any mutation and by a beatSeq change.

Root cause (audit report B): every panel poll (`/state`, `/status`, `/roster`, `/knowledge`, `/dossier`) asked the engine afresh even a split second after the same
answer (660 `/state` in 14 min on prod), queueing behind the narrator's own engine calls. Fix: `src/engine_read_cache.py`, applied ONLY to those poller routes
(`get_game_state_polled` / `game_status_polled`); the chat framing reads keep calling the engine directly.
"""
import asyncio
import os
import sys

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if FRONTEND not in sys.path:
    sys.path.insert(0, FRONTEND)

from src import engine_read_cache as cache  # noqa: E402


@pytest.fixture(autouse=True)
def _on(monkeypatch):
    monkeypatch.setenv("ORWELL_STATE_CACHE_TTL_MS", "400")  # the suite default is 0 (off); these tests exercise the cache
    cache.clear()
    yield
    cache.clear()


class Engine:
    """A fake engine: per-user state with a beat counter; every fetch is counted."""
    def __init__(self, delay=0.0):
        self.calls = 0
        self.beat = {}
        self.delay = delay

    def fetcher(self, user, name="getGameState"):
        async def f():
            self.calls += 1
            snapshot = {"user": user, "beatSeq": self.beat.get(user, 1), "week": 1, "tool": name}  # the engine answers with the state at call time
            if self.delay:
                await asyncio.sleep(self.delay)
            return snapshot
        return f


def run(coro):
    return asyncio.run(coro)


def test_second_read_inside_the_ttl_is_served_from_memory():
    eng = Engine()

    async def go():
        a = await cache.read("getGameState", "u1", eng.fetcher("u1"))
        b = await cache.read("getGameState", "u1", eng.fetcher("u1"))
        return a, b
    a, b = run(go())
    assert a == b and eng.calls == 1


def test_concurrent_reads_are_single_flight():
    eng = Engine(delay=0.05)

    async def go():
        return await asyncio.gather(*[cache.read("getGameState", "u1", eng.fetcher("u1")) for _ in range(10)])
    out = run(go())
    assert eng.calls == 1 and all(o == out[0] for o in out)


def test_ttl_expires(monkeypatch):
    monkeypatch.setenv("ORWELL_STATE_CACHE_TTL_MS", "30")
    eng = Engine()

    async def go():
        await cache.read("getGameState", "u1", eng.fetcher("u1"))
        await asyncio.sleep(0.06)
        await cache.read("getGameState", "u1", eng.fetcher("u1"))
    run(go())
    assert eng.calls == 2


def test_never_crosses_users():
    eng = Engine()

    async def go():
        a = await cache.read("getGameState", "alice", eng.fetcher("alice"))
        b = await cache.read("getGameState", "bob", eng.fetcher("bob"))
        none = await cache.read("getGameState", None, eng.fetcher(None))
        a2 = await cache.read("getGameState", "alice", eng.fetcher("alice"))
        return a, b, none, a2
    a, b, none, a2 = run(go())
    assert a["user"] == "alice" and b["user"] == "bob" and none["user"] is None and a2["user"] == "alice"
    assert eng.calls == 3  # alice, bob, anonymous each fetched once; alice's second read was a hit


def test_invalidating_one_user_leaves_the_other_cached():
    eng = Engine()

    async def go():
        await cache.read("getGameState", "alice", eng.fetcher("alice"))
        await cache.read("getGameState", "bob", eng.fetcher("bob"))
        cache.invalidate("alice")
        await cache.read("getGameState", "alice", eng.fetcher("alice"))
        await cache.read("getGameState", "bob", eng.fetcher("bob"))
    run(go())
    assert eng.calls == 3  # alice re-fetched, bob still a hit


def test_a_mutation_makes_the_next_read_fresh_not_stale():
    eng = Engine()

    async def go():
        before = await cache.read("getGameState", "u1", eng.fetcher("u1"))
        eng.beat["u1"] = 2          # the game moved on (a mutating tool ran)...
        cache.invalidate("u1")      # ...and orwell_engine._call invalidated
        after = await cache.read("getGameState", "u1", eng.fetcher("u1"))
        return before, after
    before, after = run(go())
    assert before["beatSeq"] == 1 and after["beatSeq"] == 2


def test_a_read_in_flight_across_a_mutation_is_neither_stored_nor_joined():
    eng = Engine(delay=0.05)

    async def go():
        slow = asyncio.ensure_future(cache.read("getGameState", "u1", eng.fetcher("u1")))  # reads beat 1
        await asyncio.sleep(0.01)
        eng.beat["u1"] = 2
        cache.invalidate("u1")  # a mutation lands while the slow read is in flight
        fresh = await cache.read("getGameState", "u1", eng.fetcher("u1"))  # must NOT join the pre-mutation flight
        old = await slow
        again = await cache.read("getGameState", "u1", eng.fetcher("u1"))  # the stale one must not have been stored over the fresh
        return old, fresh, again
    old, fresh, again = run(go())
    assert fresh["beatSeq"] == 2 and again["beatSeq"] == 2
    assert old["beatSeq"] == 1  # the slow caller keeps its own (pre-mutation) answer; nobody else sees it


def test_a_beat_change_seen_by_one_read_drops_the_other_cached_read():
    eng = Engine()

    async def go():
        await cache.read("gameStatus", "u1", eng.fetcher("u1", "gameStatus"))      # cached at beat 1
        eng.beat["u1"] = 5
        await cache.read("getGameState", "u1", eng.fetcher("u1"))                  # sees beat 5 -> drops the beat-1 status entry
        await cache.read("gameStatus", "u1", eng.fetcher("u1", "gameStatus"))      # must refetch
    run(go())
    assert eng.calls == 3


def test_callers_get_copies_so_a_mutating_handler_cannot_poison_the_cache():
    eng = Engine()

    async def go():
        a = await cache.read("getGameState", "u1", eng.fetcher("u1"))
        a["week"] = 999
        b = await cache.read("getGameState", "u1", eng.fetcher("u1"))
        return b
    assert run(go())["week"] == 1


def test_only_the_vault_free_state_reads_are_cacheable():
    eng = Engine()

    async def go():
        await cache.read("sealedFromHouse", "u1", eng.fetcher("u1", "sealedFromHouse"))
        await cache.read("sealedFromHouse", "u1", eng.fetcher("u1", "sealedFromHouse"))
    run(go())
    assert eng.calls == 2  # never stored
    assert cache.CACHEABLE == frozenset({"getGameState", "gameStatus"})


def test_ttl_zero_disables_it(monkeypatch):
    monkeypatch.setenv("ORWELL_STATE_CACHE_TTL_MS", "0")
    eng = Engine()

    async def go():
        await cache.read("getGameState", "u1", eng.fetcher("u1"))
        await cache.read("getGameState", "u1", eng.fetcher("u1"))
    run(go())
    assert eng.calls == 2


def test_a_failed_read_is_not_cached_and_sharers_see_the_failure():
    state = {"n": 0}

    async def boom():
        state["n"] += 1
        await asyncio.sleep(0.02)
        raise RuntimeError("engine down")

    async def go():
        res = await asyncio.gather(*[cache.read("getGameState", "u1", boom) for _ in range(3)], return_exceptions=True)
        ok = await cache.read("getGameState", "u1", Engine().fetcher("u1"))
        return res, ok
    res, ok = run(go())
    assert state["n"] == 1 and all(isinstance(r, RuntimeError) for r in res)
    assert ok["user"] == "u1"


# ---- wiring through orwell_engine._call (the invalidation hook) and the routes ------------------------------------------------------------
def test_engine_call_invalidates_on_a_mutating_tool_but_not_on_a_pure_read(monkeypatch):
    from src import orwell_engine
    calls = []

    async def fake_inner(name, args=None, user=None, timeout=None):
        calls.append(name)
        return {"started": True, "beatSeq": len(calls), "tool": name}
    monkeypatch.setattr(orwell_engine, "_call_inner", fake_inner)
    from src import log_rings
    monkeypatch.setattr(log_rings, "record_io", lambda *a, **k: None)

    async def go():
        s1 = await orwell_engine.get_game_state_polled(user="u1", timeout=1)
        await orwell_engine._call("getMomentPrompt", {}, user="u1")      # a pure read: the cache stays warm
        s2 = await orwell_engine.get_game_state_polled(user="u1", timeout=1)
        await orwell_engine._call("recordInteraction", {}, user="u1")    # a mutation: invalidates
        s3 = await orwell_engine.get_game_state_polled(user="u1", timeout=1)
        return s1, s2, s3
    s1, s2, s3 = run(go())
    assert s1 == s2                       # served from the cache (one getGameState call)
    assert s3["beatSeq"] > s2["beatSeq"]  # fresh after the mutation
    assert calls.count("getGameState") == 2


def test_pollers_use_the_cache_and_the_framing_path_does_not():
    src = open(os.path.join(FRONTEND, "routes", "orwell_routes.py"), encoding="utf-8").read()
    assert src.count("get_game_state_polled(") == 4 and src.count("game_status_polled(") == 1  # /state, /roster, /knowledge, /dossier + /status
    # the chat-blocking / mutation routes still read the engine directly
    assert "_cur = await orwell_engine.get_game_state(user=user)" in src
    chat = open(os.path.join(FRONTEND, "routes", "chat_helpers.py"), encoding="utf-8").read()
    assert "_polled(" not in chat

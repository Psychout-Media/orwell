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


# ---- review fixes -------------------------------------------------------------------------------------------------------------------------
def test_a_cancelled_leader_does_not_poison_the_followers():
    eng = Engine(delay=0.1)

    async def go():
        leader = asyncio.ensure_future(cache.read("getGameState", "u1", eng.fetcher("u1")))
        await asyncio.sleep(0.01)
        follower = asyncio.ensure_future(cache.read("getGameState", "u1", eng.fetcher("u1")))
        await asyncio.sleep(0.01)
        leader.cancel()  # the 45 s request-timeout middleware / a client disconnect
        return await follower, leader
    out, leader = run(go())
    assert out["user"] == "u1" and eng.calls == 1  # the follower still gets the one shared engine answer
    assert leader.cancelled()


def test_a_failing_mutation_still_invalidates(monkeypatch):
    from src import orwell_engine, log_rings
    monkeypatch.setattr(log_rings, "record_io", lambda *a, **k: None)
    state = {"beat": 1}

    async def fake_inner(name, args=None, user=None, timeout=None):
        if name == "submitDecision":
            state["beat"] = 2          # the engine APPLIED it...
            raise TimeoutError("read timeout")  # ...but the client never saw the answer
        return {"started": True, "beatSeq": state["beat"]}
    monkeypatch.setattr(orwell_engine, "_call_inner", fake_inner)

    async def go():
        a = await orwell_engine.get_game_state_polled(user="u1", timeout=1)
        try:
            await orwell_engine._call("submitDecision", {}, user="u1")
        except TimeoutError:
            pass
        b = await orwell_engine.get_game_state_polled(user="u1", timeout=1)
        return a, b
    a, b = run(go())
    assert a["beatSeq"] == 1 and b["beatSeq"] == 2


def test_pure_reads_list_is_pinned():
    # adding a tool here means it can no longer invalidate; a mutating tool in this set would serve stale state. Review deliberately.
    assert cache.PURE_READS == frozenset({
        "getGameState", "gameStatus", "getMomentPrompt", "stateDelta", "getVisibleStateFor", "whereabouts", "renderScene", "socialRead",
        "seasonRecap", "dailyRecap", "playerReceipts", "playerDossier", "playerTagline", "socialInitiatives", "worldSnapshotView", "npcVoice",
        "competitionStagingView",
    })


def test_every_pure_read_is_a_real_engine_tool_name():
    """Greptile on #2265: the list carried `getVisibleState`, but the FE calls `getVisibleStateFor`, so the /knowledge and /dossier reads
    invalidated the cache on every poll. Every name must be a tool orwell_engine actually calls, or it guards nothing."""
    import re
    src = open(os.path.join(FRONTEND, "src", "orwell_engine.py"), encoding="utf-8").read()
    called = set(re.findall(r'_call\("(\w+)"', src))
    assert cache.PURE_READS <= called, sorted(cache.PURE_READS - called)


def test_state_route_is_fresh_after_a_decision_with_the_cache_on(monkeypatch):
    """/state, then a decision, then /state must show the new beat (the cache is ON here; the suite default is off)."""
    import importlib
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from src import orwell_engine, log_rings
    routes = importlib.import_module("routes.orwell_routes")
    monkeypatch.setattr(log_rings, "record_io", lambda *a, **k: None)
    st = {"beat": 1, "reads": 0}

    async def fake_inner(name, args=None, user=None, timeout=None):
        if name == "getGameState":
            st["reads"] += 1
            return {"started": True, "beatSeq": st["beat"], "phase": "x"}
        if name == "submitDecision":
            st["beat"] += 1
            return {"ok": True}
        return {}
    monkeypatch.setattr(orwell_engine, "_call_inner", fake_inner)
    app = FastAPI()
    app.include_router(routes.setup_orwell_routes())
    client = TestClient(app, raise_server_exceptions=False)
    r1 = client.get("/api/orwell/state")
    r2 = client.get("/api/orwell/state")
    assert r1.status_code == 200 and st["reads"] == 1  # second poll served from the cache
    run(orwell_engine.submit_decision({"choice": "x"}, user=None))
    r3 = client.get("/api/orwell/state")
    assert r3.json()["beatSeq"] == 2 and st["reads"] == 2


# ---- handover fixes (Greptile on aa573da1) --------------------------------------------------------------------------------------------------
def _route_client(monkeypatch, fake_inner):
    import importlib
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from src import orwell_engine, log_rings
    routes = importlib.import_module("routes.orwell_routes")
    monkeypatch.setattr(log_rings, "record_io", lambda *a, **k: None)
    monkeypatch.setattr(orwell_engine, "_call_inner", fake_inner)
    app = FastAPI()
    app.include_router(routes.setup_orwell_routes())
    return TestClient(app, raise_server_exceptions=False)


def test_the_panel_routes_share_one_cached_state_read(monkeypatch):
    """/state, /knowledge, /dossier and /whereabouts polled inside one TTL window make ONE getGameState engine call: their own reads
    (`getVisibleStateFor`, `whereabouts`) are pure, so they no longer wipe the player's cached state before and after themselves."""
    monkeypatch.setenv("ORWELL_STATE_CACHE_TTL_MS", "10000")  # a slow runner must not expire the entry mid-test; the TTL is not under test
    calls = []

    async def fake_inner(name, args=None, user=None, timeout=None):
        calls.append(name)
        if name == "getGameState":
            return {"started": True, "beatSeq": 7, "phase": "x", "house": [{"id": "npc:1", "name": "Houseguest One"}]}
        if name == "getVisibleStateFor":
            return {"knowledge": [], "visibleEvents": []}
        if name == "whereabouts":
            return None
        return {}
    client = _route_client(monkeypatch, fake_inner)
    assert client.get("/api/orwell/state").status_code == 200
    assert client.get("/api/orwell/knowledge").json().get("started") is True
    assert client.get("/api/orwell/dossier/npc:1").json().get("found") is True
    assert client.get("/api/orwell/whereabouts").status_code == 200
    assert client.get("/api/orwell/state").status_code == 200
    assert calls.count("getGameState") == 1, calls
    assert calls.count("getVisibleStateFor") == 2  # the panels' own reads still go to the engine (not cacheable)


def test_a_swept_user_record_never_revives_a_read_that_began_before_a_mutation(monkeypatch):
    """Greptile on #2265: the idle sweep dropped a user's generation counter, resetting it to 0, so a read that began before a mutation
    (generation 0) passed the freshness check again and stored PRE-mutation state as fresh. Ticks are never reused now, and a retired
    record's last invalidation is folded into a floor every record-less user is measured against."""
    monkeypatch.setenv("ORWELL_STATE_CACHE_TTL_MS", "30")
    monkeypatch.setattr(cache, "_MAX_USERS", 2)
    cache.clear()  # re-arms the sweep threshold from the patched bound
    slow = Engine(delay=0.5)   # the read that began before the mutation
    eng = Engine()             # every other read

    async def go():
        a = asyncio.ensure_future(cache.read("getGameState", "u1", slow.fetcher("u1")))   # snapshots beat 1, then waits
        await asyncio.sleep(0.01)
        slow.beat["u1"] = eng.beat["u1"] = 2
        cache.invalidate("u1")                                                           # a mutation lands
        assert (await cache.read("getGameState", "u1", eng.fetcher("u1")))["beatSeq"] == 2
        await asyncio.sleep(0.05)                                                        # u1's fresh entry expires: u1 is idle now
        for i in range(12):                                                              # other players' traffic sweeps the records
            cache.invalidate(f"other{i}")
            await cache.read("getGameState", f"reader{i}", eng.fetcher(f"reader{i}"))
        old = await a                                                                    # the pre-mutation read lands only now
        before = eng.calls
        now = await cache.read("getGameState", "u1", eng.fetcher("u1"))
        return old, now, eng.calls - before
    old, now, fetched = run(go())
    assert old["beatSeq"] == 1                      # the slow caller keeps its own answer...
    assert now["beatSeq"] == 2 and fetched == 1     # ...but it was never stored: the next read asks the engine


def test_per_user_records_stay_bounded_and_are_swept_amortized(monkeypatch):
    """Greptile on #2265: the sweep only ever ran off the entry count, so the per-user generation and last-seen-beat records grew for the
    life of the process (a player who mutates after polling leaves no entry behind). Every record kind now triggers the sweep, idle users'
    records are retired, and the threshold is re-armed so a cache full of live users is not swept on every call."""
    monkeypatch.setattr(cache, "_MAX_USERS", 4)
    cache.clear()
    sweeps = {"n": 0}
    real = cache._sweep_locked

    def counting():
        sweeps["n"] += 1
        real()
    monkeypatch.setattr(cache, "_sweep_locked", counting)
    eng = Engine()
    peak = 0

    async def go():
        nonlocal peak
        for i in range(500):
            u = f"p{i}"
            await cache.read("getGameState", u, eng.fetcher(u))                 # a poll (records the beat it saw)
            cache.invalidate(u)                                                  # a mutation (records the user's invalidation)
            await cache.read("gameStatus", u, eng.fetcher(u, "gameStatus"))     # the next poll
            peak = max(peak, len(cache._INV), len(cache._BEAT), len(cache._ENTRIES))
    run(go())
    assert peak <= 4 * 4 + 1, peak                 # never more than the sweep threshold (+ the record that tripped it)
    assert 0 < sweeps["n"] < 200, sweeps           # swept regularly, but nowhere near once per call (1,000 calls)

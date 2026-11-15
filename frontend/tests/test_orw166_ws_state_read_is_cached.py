"""ORW-166: the WS channel's per-edge beatSeq read goes through the HUD-poller cache (single-flight + short TTL, invalidated by any mutation), so a burst of bus edges costs ONE engine read. No model."""
import asyncio
import importlib

from src import engine_read_cache, orwell_engine
from routes import ws_routes


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def test_a_burst_of_edges_shares_one_engine_read(monkeypatch):
    monkeypatch.setenv("ORWELL_STATE_CACHE_TTL_MS", "400")
    calls = []

    async def fake_call(name, args=None, user=None, timeout=None):
        calls.append(name)
        await asyncio.sleep(0.02)
        return {"started": True, "beatSeq": 7}

    monkeypatch.setattr(orwell_engine, "_call_inner", fake_call)
    engine_read_cache.invalidate("ws-user")

    async def burst():
        return await asyncio.gather(*[ws_routes._engine_state("ws-user") for _ in range(8)])

    out = _run(burst())
    assert all(o.get("beatSeq") == 7 for o in out)
    assert calls.count("getGameState") == 1, calls


def test_a_mutation_invalidates_so_the_next_edge_reads_fresh(monkeypatch):
    monkeypatch.setenv("ORWELL_STATE_CACHE_TTL_MS", "400")
    seq = {"n": 1}
    calls = []

    async def fake_call(name, args=None, user=None, timeout=None):
        calls.append(name)
        if name == "getGameState":
            return {"started": True, "beatSeq": seq["n"]}
        seq["n"] += 1
        return {"ok": True}

    monkeypatch.setattr(orwell_engine, "_call_inner", fake_call)
    engine_read_cache.invalidate("ws-user2")
    assert _run(ws_routes._engine_state("ws-user2"))["beatSeq"] == 1
    _run(orwell_engine._call("advanceGame", {}, user="ws-user2"))  # a mutating tool
    assert _run(ws_routes._engine_state("ws-user2"))["beatSeq"] == 2

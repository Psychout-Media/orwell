"""ORW-542 - the sender's run-started edge must not wait on a slow engine read.

The state channel is ONE serial loop: each bus edge awaited an engine state read before its frame was sent. During casting the
engine is busy for minutes (cast authoring), so a read that never answers held the loop, and every later edge - including the
`run-started` edge that tells the sending window to attach to its own reply - queued behind it. The reply was saved, but the
live tab kept the placeholder until a reload. The read is now bounded; the edge goes out with the last known beat.

Driven against the REAL `ws_session` handler via the shared ws_harness. Roles only; no names."""
import asyncio
import importlib

import pytest

from tests.support import ws_harness as H

ws_routes = importlib.import_module("routes.ws_routes")
ogs = importlib.import_module("src.orwell_game_session")
session_events = importlib.import_module("src.session_events")


@pytest.fixture(autouse=True)
def _env(tmp_path, monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setattr(ogs, "GAME_SESSION_PATH", tmp_path / "orwell_game_session.json")
    monkeypatch.setattr(ws_routes, "_is_live", lambda sid: True)
    H.reset_runs()
    session_events._RING.clear()
    yield
    H.reset_runs()
    session_events._RING.clear()


def test_run_started_edge_is_sent_while_an_engine_read_hangs(run, monkeypatch):
    async def main():
        calls = {"n": 0}

        async def _state(user):
            calls["n"] += 1
            if calls["n"] > 1:      # the handshake read answers; every later (edge) read hangs like a busy engine
                await asyncio.sleep(3600)
            return {"started": True, "beatSeq": 7}

        monkeypatch.setattr(ws_routes, "_engine_state", _state)
        monkeypatch.setattr(ws_routes, "_EDGE_STATE_READ_S", 0.2, raising=False)
        canon = H.seed_live_game(None, "live-canon")
        ws = H.new_ws(); t = H.spawn(ws)
        await H.hello(ws, canon)
        ws.client_send({"t": "subscribe", "ch": "state", "cid": "c_s1"})
        for _ in range(400):
            if session_events.subscriber_count(canon) == 1:
                break
            await asyncio.sleep(0.005)
        session_events.publish(canon, "game-updated")     # a cast-authoring write: its read hangs
        session_events.publish(canon, "run-started")      # then the sender's own turn
        st = await ws.recv_where(lambda f: f.get("t") == "state" and (f.get("d") or {}).get("reason") == "run-started", timeout=3.0)
        assert st["d"]["reason"] == "run-started"
        await H.stop(ws, t)

    run(main())


def test_run_started_edge_is_not_queued_behind_a_burst_of_hung_edge_reads(run, monkeypatch):
    """ORW-706: casting genesis publishes a burst of game-updated edges. Each one used to wait its own bound on the same hung read, so the sender's
    run-started edge sat behind the whole burst (a casting reply stuck for minutes). The bound is now paid once per busy spell."""
    async def main():
        calls = {"n": 0}

        async def _state(user):
            calls["n"] += 1
            if calls["n"] > 1:
                await asyncio.sleep(3600)
            return {"started": False, "beatSeq": 7}

        monkeypatch.setattr(ws_routes, "_engine_state", _state)
        monkeypatch.setattr(ws_routes, "_EDGE_STATE_READ_S", 0.3, raising=False)
        canon = H.seed_live_game(None, "live-canon")
        ws = H.new_ws(); t = H.spawn(ws)
        await H.hello(ws, canon)
        ws.client_send({"t": "subscribe", "ch": "state", "cid": "c_s1"})
        for _ in range(400):
            if session_events.subscriber_count(canon) == 1:
                break
            await asyncio.sleep(0.005)
        for _ in range(20):
            session_events.publish(canon, "game-updated")
        session_events.publish(canon, "run-started")
        _t0 = asyncio.get_event_loop().time()
        st = await ws.recv_where(lambda f: f.get("t") == "state" and (f.get("d") or {}).get("reason") == "run-started", timeout=1.5)
        assert st["d"]["reason"] == "run-started"
        assert asyncio.get_event_loop().time() - _t0 < 1.5   # the whole burst is not paid edge by edge (20 x 0.3 s)
        await H.stop(ws, t)

    run(main())

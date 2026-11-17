"""ORW-491: a turn queued behind a long one stays counted as in flight for as long as its queued run is alive (not only for the 15 s admission TTL), so the updater never reads
"0 in flight" in the gap between the first turn ending and the queued turn registering its stream. The admission is released on every path, under the key it was admitted under.
Roles only."""
import asyncio
import importlib
import time

import pytest

from tests.support import ws_harness as H

ws_routes = importlib.import_module("routes.ws_routes")
ogs = importlib.import_module("src.orwell_game_session")
ti = importlib.import_module("src.turn_inflight")


@pytest.fixture(autouse=True)
def _env(tmp_path, monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setenv("ORWELL_INFLIGHT_DIR", str(tmp_path))
    monkeypatch.setenv("ORWELL_RUN_DIR", str(tmp_path))
    monkeypatch.setattr(ogs, "GAME_SESSION_PATH", tmp_path / "orwell_game_session.json")
    monkeypatch.setattr(ws_routes, "_is_live", lambda sid: True)
    for m in (ti._admitting, ti._expired, ti._pinned):
        m.clear()
    ti._registry_size = 0
    H.reset_runs()
    yield
    H.reset_runs()
    ws_routes.set_turn_stream_factory(None)
    for m in (ti._admitting, ti._expired, ti._pinned):
        m.clear()


def _inflight(tmp_path):
    return int((tmp_path / "turns-in-flight").read_text().strip())


class _Clock:
    """A fake monotonic clock for turn_inflight: advancing it ages every admission without touching their stamps."""
    offset = 0.0


@pytest.fixture(autouse=True)
def _clock(monkeypatch):
    real = time.monotonic
    _Clock.offset = 0.0
    monkeypatch.setattr(ti, "time", type("T", (), {"monotonic": staticmethod(lambda: real() + _Clock.offset), "time": staticmethod(time.time)}))


def _age(_key, secs):
    _Clock.offset += secs


def test_a_pinned_admission_outlives_the_ttl_until_released(tmp_path):
    assert ti.check_and_admit("m-b") is None
    stamp = ti.admit_pin("m-b")
    _age("m-b", ti._ADMIT_TTL_S + 100)
    ti.admit_begin("other"); ti.admit_end("other")           # any later publish recounts
    assert _inflight(tmp_path) == 1, "a pinned admission does not expire"
    ti.admit_release_pinned("m-b", stamp)
    assert _inflight(tmp_path) == 0 and not ti._admitting and not ti._pinned
    ti.admit_release_pinned("m-b", stamp)                    # exactly once
    assert _inflight(tmp_path) == 0


def test_the_registration_hands_a_pinned_admission_over_and_the_later_release_is_a_no_op(tmp_path):
    ti.check_and_admit("m-b"); stamp = ti.admit_pin("m-b")
    ti._registry_size = 1; ti.publish_inflight(1)
    ti.admit_end("m-b")
    assert not ti._pinned and not ti._admitting
    ti.admit_release_pinned("m-b", stamp)
    assert not ti._admitting


def test_an_unpinned_admission_still_expires_at_the_ttl_backstop(tmp_path):
    ti.check_and_admit("m-x"); _age("m-x", ti._ADMIT_TTL_S + 1)
    ti.admit_begin("m-y")
    assert list(ti._admitting) == ["m-y"] and _inflight(tmp_path) == 1


def _setup(monkeypatch):
    async def _state(user):
        return {"started": True, "beatSeq": 10}
    monkeypatch.setattr(ws_routes, "_engine_state", _state)


def test_a_turn_queued_behind_a_long_one_stays_counted_across_the_gap_when_the_first_ends(run, tmp_path, monkeypatch):
    """The reproduction: A runs past the TTL, B is admitted and queues, A ends: the count must stay >= 1 while B is queued and has not registered."""
    _setup(monkeypatch)
    gate_a, gate_b = asyncio.Event(), asyncio.Event()
    seen = []

    def _factory(d, canonical, user):
        mid = d.get("clientMsgId")
        seen.append(mid)

        async def _agen():
            if mid == "m-a":
                ti._registry_size = 1; ti.publish_inflight(ti._total_locked())   # A registers its stream like stream_with_save does
                ti.admit_end("m-a")
                await gate_a.wait()
                ti._registry_size = 0
                ti.publish_inflight(ti._total_locked())   # A's stream leaves the registry: the count is published at this instant
            else:
                await gate_b.wait()   # B has not registered yet
            yield H.sse_done()
        return _agen()

    ws_routes.set_turn_stream_factory(_factory)

    async def main():
        canon = H.seed_live_game(None, "live-canon")
        ws = H.new_ws(); t = H.spawn(ws)
        await H.hello(ws, canon)
        ws.client_send({"t": "turn", "ch": "chat", "cid": "c1", "d": {"message": "one", "clientMsgId": "m-a", "expectedBeatSeq": 10}})
        await ws.recv_where(lambda f: f.get("t") == "ack" and f.get("cid") == "c1")
        ws.client_send({"t": "turn", "ch": "chat", "cid": "c2", "d": {"message": "two", "clientMsgId": "m-b", "expectedBeatSeq": 10}})
        await ws.recv_where(lambda f: f.get("t") == "ack" and f.get("cid") == "c2")
        _age("m-b", ti._ADMIT_TTL_S + 5)          # A has been running longer than the admission TTL
        gate_a.set()                               # A ends, B is next but has not registered
        for _ in range(20):
            await asyncio.sleep(0)
        assert seen == ["m-a", "m-b"]
        assert _inflight(tmp_path) >= 1, "B is queued and unregistered: the updater must still see it"
        gate_b.set()
        for _ in range(100):
            if not ti._admitting:
                break
            await asyncio.sleep(0.01)
        assert not ti._admitting and not ti._pinned, (ti._admitting, ti._pinned, ti._registry_size)
        assert _inflight(tmp_path) == 0, "released when the queued run ends"
        await H.stop(ws, t)
        await H.aclose_runs()

    run(main())


def test_a_turn_with_no_client_msg_id_is_released_under_the_key_it_was_admitted_under(run, tmp_path, monkeypatch):
    _setup(monkeypatch)
    gate = asyncio.Event()

    def _factory(d, canonical, user):
        async def _agen():
            await gate.wait()
            yield H.sse_done()
        return _agen()

    ws_routes.set_turn_stream_factory(_factory)

    async def main():
        canon = H.seed_live_game(None, "live-canon")
        ws = H.new_ws(); t = H.spawn(ws)
        await H.hello(ws, canon)
        ws.client_send({"t": "turn", "ch": "chat", "cid": "c-nocmid", "d": {"message": "hi", "expectedBeatSeq": 10}})
        await ws.recv_where(lambda f: f.get("t") == "ack" and f.get("cid") == "c-nocmid")
        assert "c-nocmid" in ti._admitting
        gate.set()
        for _ in range(20):
            await asyncio.sleep(0)
        assert not ti._admitting and not ti._pinned and _inflight(tmp_path) == 0, "no lingering until the TTL"
        await H.stop(ws, t)
        await H.aclose_runs()

    run(main())


def test_a_queued_run_cancelled_before_it_starts_releases_its_admission(run, tmp_path, monkeypatch):
    _setup(monkeypatch)
    gate_a = asyncio.Event()

    def _factory(d, canonical, user):
        mid = d.get("clientMsgId")

        async def _agen():
            if mid == "m-a":
                await gate_a.wait()
            yield H.sse_done()
        return _agen()

    ws_routes.set_turn_stream_factory(_factory)

    async def main():
        canon = H.seed_live_game(None, "live-canon")
        ws = H.new_ws(); t = H.spawn(ws)
        await H.hello(ws, canon)
        for cid, mid in (("c1", "m-a"), ("c2", "m-b")):
            ws.client_send({"t": "turn", "ch": "chat", "cid": cid, "d": {"message": "x", "clientMsgId": mid, "expectedBeatSeq": 10}})
            await ws.recv_where(lambda f, cid=cid: f.get("t") == "ack" and f.get("cid") == cid)
        assert _inflight(tmp_path) == 2
        ws_routes.agent_runs._RUNS[canon].task.cancel()   # the queued run (B, the newest) is stopped (session delete / stop) while still waiting behind A
        for _ in range(20):
            await asyncio.sleep(0)
        assert "m-b" not in ti._admitting and _inflight(tmp_path) == 1
        gate_a.set()
        await H.stop(ws, t)
        await H.aclose_runs()

    run(main())


def test_a_turn_whose_factory_fails_before_it_starts_releases_its_admission(run, tmp_path, monkeypatch):
    _setup(monkeypatch)

    def _factory(d, canonical, user):
        raise RuntimeError("boom")

    ws_routes.set_turn_stream_factory(_factory)

    async def main():
        canon = H.seed_live_game(None, "live-canon")
        ws = H.new_ws(); t = H.spawn(ws)
        await H.hello(ws, canon)
        ws.client_send({"t": "turn", "ch": "chat", "cid": "c1", "d": {"message": "x", "clientMsgId": "m-f", "expectedBeatSeq": 10}})
        err = await ws.recv_where(lambda f: f.get("t") == "error" and f.get("cid") == "c1")
        assert err["d"]["code"] == "turn-failed"
        assert not ti._admitting and not ti._pinned and _inflight(tmp_path) == 0
        await H.stop(ws, t)
        await H.aclose_runs()

    run(main())

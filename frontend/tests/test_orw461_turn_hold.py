"""ORW-461 (server half): while an update holds new turns (the updater's `turns-hold` file), a chat turn is refused at admission with a retryable `update-holding`, BEFORE anything
starts; a turn that was admitted is counted as in flight from that instant until its stream registers, so the updater can never read "0 in flight" while a turn it did not
refuse is about to start; the hold expires by itself. Roles only."""
import importlib
import json
import os
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
    monkeypatch.setenv("ORWELL_RUN_DIR", str(tmp_path))   # the hold lives in the root-owned run dir; the in-flight count in the data dir (one temp dir stands in for both)
    monkeypatch.setattr(ogs, "GAME_SESSION_PATH", tmp_path / "orwell_game_session.json")
    monkeypatch.setattr(ws_routes, "_is_live", lambda sid: True)
    ti._admitting.clear()
    ti._expired.clear()
    ti._queued.clear()
    ti._registry_size = 0
    H.reset_runs()
    yield
    H.reset_runs()
    ws_routes.set_turn_stream_factory(None)
    ti._admitting.clear()
    ti._expired.clear()
    ti._queued.clear()


def _hold(tmp_path, seconds):
    (tmp_path / "turns-hold").write_text(f"until={int(time.time()) + seconds}\n")


def _inflight(tmp_path):
    return int((tmp_path / "turns-in-flight").read_text().strip())


# ── the hold file ─────────────────────────────────────────────────────────────────────────────────────────────────────
def test_the_hold_is_in_force_only_for_a_valid_future_stamp(tmp_path):
    assert ti.hold_until() is None                                   # no file
    _hold(tmp_path, 60)
    assert ti.hold_until() is not None
    (tmp_path / "turns-hold").write_text(f"until={int(time.time()) - 5}\n")
    assert ti.hold_until() is None                                   # expired: an updater that died never holds the game for ever
    (tmp_path / "turns-hold").write_text("until=soon\n")
    assert ti.hold_until() is None                                   # malformed
    (tmp_path / "turns-hold").write_text(f"until={int(time.time()) + 10 ** 7}\n")
    assert ti.hold_until() is None                                   # absurdly far ahead is not believed
    (tmp_path / "turns-hold").write_text("garbage")
    assert ti.hold_until() is None
    for bad in ("nan", "inf", "-inf", "NaN"):
        (tmp_path / "turns-hold").write_text(f"until={bad}\n")
        assert ti.hold_until() is None, bad                           # a non-finite stamp is no hold (and int(nan * 1000) would raise in the socket handler)


def test_the_hold_is_read_from_the_root_owned_run_dir_not_the_data_dir(tmp_path, monkeypatch):
    run_dir, data_dir = tmp_path / "run", tmp_path / "data"
    run_dir.mkdir(); data_dir.mkdir()
    monkeypatch.setenv("ORWELL_RUN_DIR", str(run_dir)); monkeypatch.setenv("ORWELL_INFLIGHT_DIR", str(data_dir))
    (data_dir / "turns-hold").write_text(f"until={int(time.time()) + 60}\n")   # a file the service user could plant in its own data dir
    assert ti.hold_until() is None, "the data dir is not trusted for the hold"
    (run_dir / "turns-hold").write_text(f"until={int(time.time()) + 60}\n")
    assert ti.hold_until() is not None
    monkeypatch.delenv("ORWELL_RUN_DIR")
    assert ti.hold_path() == "/run/orwell/turns-hold"


# ── the admission count ───────────────────────────────────────────────────────────────────────────────────────────────
def test_an_admitted_turn_counts_as_in_flight_until_it_registers_with_no_gap(tmp_path):
    assert ti.check_and_admit("c-1") is None
    assert _inflight(tmp_path) == 1                                  # counted from the admission itself
    reg = ti.InflightRegistry()
    reg["sess"] = {"status": "streaming"}                            # the stream registers ...
    assert _inflight(tmp_path) == 2                                  # ... first both, so the count never dips to 0
    ti.admit_end("c-1")                                              # ... then the admission hands over
    assert _inflight(tmp_path) == 1
    del reg["sess"]
    assert _inflight(tmp_path) == 0


def test_a_turn_that_never_registers_stops_counting_after_the_ttl(tmp_path):
    assert ti.check_and_admit("c-lost") is None
    assert _inflight(tmp_path) == 1
    ti._admitting["c-lost"][0] -= ti._ADMIT_TTL_S + 1      # it failed before registering: long past the TTL
    ti.admit_begin("c-next")                              # any later publish recounts
    assert list(ti._admitting) == ["c-next"] and _inflight(tmp_path) == 1


def test_a_hold_written_while_the_turn_is_being_counted_still_refuses_it(tmp_path, monkeypatch):
    # review of #2805: the updater writes the hold between this turn's first look and its count reaching disk. The second look, after the count is published, refuses it.
    reads = iter([None, time.time() + 60])
    monkeypatch.setattr(ti, "hold_until", lambda now=None: next(reads))
    assert ti.check_and_admit("c-race") is not None
    assert not ti._admitting and _inflight(tmp_path) == 0


def test_the_same_turn_admitted_twice_is_counted_twice(tmp_path):
    # review of #2805: a re-send of the same clientMsgId queued behind the first; the first stream's registration must not drop the second from the count.
    assert ti.check_and_admit("c-1") is None and ti.check_and_admit("c-1") is None
    assert _inflight(tmp_path) == 2
    ti.admit_end("c-1")
    assert _inflight(tmp_path) == 1
    ti.admit_end("c-1")
    assert _inflight(tmp_path) == 0 and not ti._admitting


def test_an_older_admission_past_the_ttl_releases_itself_not_a_newer_one(tmp_path):
    # review of #2854: the first admission sat queued behind a long run past the TTL (it stopped counting); a re-send of the same clientMsgId is admitted. When the FIRST one
    # finally registers, its admit_end must release the first, never the re-send's live stamp, or the updater reads 0 while the re-send is about to start.
    assert ti.check_and_admit("c-1") is None
    ti._admitting["c-1"][0] -= ti._ADMIT_TTL_S + 1
    assert ti.check_and_admit("c-1") is None
    assert _inflight(tmp_path) == 1                       # the re-send only: the first one is past the TTL
    ti.admit_end("c-1")                                   # the FIRST admission registers
    assert _inflight(tmp_path) == 1 and len(ti._admitting.get("c-1") or []) == 1, "the re-send is still counted"
    ti.admit_end("c-1")                                   # the re-send registers
    assert _inflight(tmp_path) == 0 and not ti._admitting and not ti._expired


# ORW-491: a turn queued behind a long game turn stays counted past the TTL until its own stream registers (or its run ends without registering).
def test_orw491_a_queued_turn_keeps_counting_past_the_ttl_until_it_registers(tmp_path):
    reg = ti.InflightRegistry()
    reg["first"] = {"status": "streaming"}                # the long turn that is running
    assert ti.check_and_admit("c-2") is None
    h = ti.pin_admission("c-2")                           # handed to the run queue behind it
    assert h is not None and _inflight(tmp_path) == 2
    time.sleep(0.01)
    ti._ADMIT_TTL_S, old = 0.0, ti._ADMIT_TTL_S           # far past the TTL
    try:
        assert _inflight(tmp_path) == 2
        del reg["first"]                                  # the first turn ends: the queued one must still count, or the updater reads 0 in the gap
        assert _inflight(tmp_path) == 1
    finally:
        ti._ADMIT_TTL_S = old
    reg["second"] = {"status": "streaming"}               # its producer registers ...
    ti.admit_end("c-2")                                   # ... and the admission hands over
    assert _inflight(tmp_path) == 1
    ti.release_admission(h)                               # the run's done-callback after a normal finish is a no-op
    assert _inflight(tmp_path) == 1
    del reg["second"]
    assert _inflight(tmp_path) == 0


def test_orw491_a_queued_turn_whose_run_ends_unregistered_is_released(tmp_path):
    assert ti.check_and_admit("c-3") is None
    h = ti.pin_admission("c-3")
    assert _inflight(tmp_path) == 1
    ti.release_admission(h)                               # cancelled (Stop / session delete) or failed before registering
    assert _inflight(tmp_path) == 0 and not ti._queued
    ti.release_admission(h)                               # idempotent
    assert _inflight(tmp_path) == 0


def test_orw491_releasing_one_queued_turn_never_drops_another(tmp_path):
    ti.check_and_admit("c-a"); ha = ti.pin_admission("c-a")
    ti.check_and_admit("c-b"); hb = ti.pin_admission("c-b")
    assert _inflight(tmp_path) == 2
    ti.release_admission(ha)
    assert _inflight(tmp_path) == 1 and list(ti._queued.values()) == ["c-b"]
    ti.release_admission(ha)
    assert _inflight(tmp_path) == 1
    ti.release_admission(hb)
    assert _inflight(tmp_path) == 0


def test_orw491_the_socket_pins_the_queued_turn_and_releases_it_when_the_run_ends():
    src = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "routes", "ws_routes.py"), encoding="utf-8").read()
    i = src.index("agent_runs.start(sock[\"canonical\"], producer, queue=True)")
    seg = src[i:i + 900]
    assert "pin_admission(" in seg and "add_done_callback" in seg and "release_admission(" in seg


def test_a_refused_turn_is_not_counted(tmp_path):
    _hold(tmp_path, 60)
    assert ti.check_and_admit("c-1") is not None
    assert not ti._admitting


# ── the socket: refuse before anything starts, never double ─────────────────────────────────────────────────────────────
def test_a_turn_during_the_hold_is_refused_unstarted_and_the_same_turn_goes_through_afterwards(run, tmp_path, monkeypatch):
    async def _state(user):
        return {"started": True, "beatSeq": 10}
    monkeypatch.setattr(ws_routes, "_engine_state", _state)
    seen = []

    def _factory(d, canonical, user):
        seen.append(d.get("clientMsgId"))
        async def _agen():
            yield H.sse_done()
        return _agen()

    ws_routes.set_turn_stream_factory(_factory)
    _hold(tmp_path, 60)

    async def main():
        canon = H.seed_live_game(None, "live-canon")
        ws = H.new_ws(); t = H.spawn(ws)
        await H.hello(ws, canon)
        ws.client_send({"t": "turn", "ch": "chat", "cid": "c1", "d": {"message": "hello", "clientMsgId": "m-1", "expectedBeatSeq": 10}})
        err = await ws.recv_where(lambda f: f.get("t") == "error" and f.get("cid") == "c1")
        assert err["d"]["code"] == "update-holding" and err["d"]["retryAfterMs"] > 0 and err["d"]["untilMs"] > time.time() * 1000
        assert seen == [] and not ws_routes.agent_runs.has_run(canon), "nothing started: the turn was refused at admission"
        assert not (tmp_path / "turns-in-flight").exists() or _inflight(tmp_path) == 0, "a refused turn is not counted"
        # the hold is lifted after the restart: the SAME clientMsgId is sent again and runs exactly once
        os.unlink(tmp_path / "turns-hold")
        ws.client_send({"t": "turn", "ch": "chat", "cid": "c2", "d": {"message": "hello", "clientMsgId": "m-1", "expectedBeatSeq": 10}})
        ack = await ws.recv_where(lambda f: f.get("t") == "ack" and f.get("cid") == "c2")
        assert ack["d"]["accepted"] is True
        assert seen == ["m-1"], "the turn ran exactly once"
        await H.stop(ws, t)
        await H.aclose_runs()

    run(main())


def test_a_turn_admitted_before_the_hold_is_counted_so_the_updater_waits_for_it(run, tmp_path, monkeypatch):
    async def _state(user):
        return {"started": True, "beatSeq": 10}
    monkeypatch.setattr(ws_routes, "_engine_state", _state)
    import asyncio
    gate = asyncio.Event()

    def _factory(d, canonical, user):
        async def _agen():
            await gate.wait()   # the run is still going (queued or starting); the stub never registers a stream
            yield H.sse_done()
        return _agen()

    ws_routes.set_turn_stream_factory(_factory)

    async def main():
        canon = H.seed_live_game(None, "live-canon")
        ws = H.new_ws(); t = H.spawn(ws)
        await H.hello(ws, canon)
        ws.client_send({"t": "turn", "ch": "chat", "cid": "c1", "d": {"message": "hello", "clientMsgId": "m-9", "expectedBeatSeq": 10}})
        await ws.recv_where(lambda f: f.get("t") == "ack" and f.get("cid") == "c1")
        # admitted: in the count until its stream registers; ORW-491 holds it past the TTL while its run is alive, and releases it when the run ends without registering
        assert "m-9" in ti._queued.values() and _inflight(tmp_path) == 1
        gate.set()
        for _ in range(50):
            await asyncio.sleep(0.01)
            if _inflight(tmp_path) == 0:
                break
        assert _inflight(tmp_path) == 0 and not ti._queued
        await H.stop(ws, t)
        await H.aclose_runs()

    run(main())


def test_the_sse_route_refuses_during_the_hold_too():
    src = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "routes", "chat_routes.py"), encoding="utf-8").read()
    i = src.index("async def chat_stream(request: Request)")
    blk = src[i:i + 2500]
    assert "check_and_admit" in blk and "update-holding" in blk and blk.index("check_and_admit") < blk.index("_prepare_chat_stream(request)")
    assert "_turn_inflight.admit_end(client_msg_id)" in src, "the admission hands over to the registry when the stream registers"


def test_an_unreadable_hold_is_reported_not_silently_ignored(tmp_path, caplog):
    import logging
    if os.geteuid() == 0:
        pytest.skip("root can read a 0000 file")
    (tmp_path / "turns-hold").write_text(f"until={int(time.time()) + 60}\n")
    os.chmod(tmp_path / "turns-hold", 0)
    ti._warned_unreadable = False
    with caplog.at_level(logging.WARNING):
        assert ti.hold_until() is None
        assert ti.hold_until() is None
    msgs = [r.getMessage() for r in caplog.records if "cannot be read" in r.getMessage()]
    assert len(msgs) == 1 and "NOT being held" in msgs[0], "one warning, naming the consequence"
    os.chmod(tmp_path / "turns-hold", 0o644)
    assert ti.hold_until() is not None

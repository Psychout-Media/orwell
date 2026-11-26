"""WebSocket Phase-1 — case (f-CAS): the beatSeq compare-and-swap over the socket (0065).

A ``turn``/``decision`` up-frame carrying a stale ``expectedBeatSeq`` is refused with an ``error``
frame ``{cid, code:"stale-beat", d:{beatSeq}}`` — the socket-native form of the HTTP 409 ``stale-beat``
contract — and NO write happens; a fresh token proceeds. The ``cid`` echoes the up-frame so the client
rejects the right promise (protocol spec §3.5, test-plan case f). Roles only; no names.
"""
import importlib

import pytest

from tests.support import ws_harness as H

ws_routes = importlib.import_module("routes.ws_routes")
ogs = importlib.import_module("src.orwell_game_session")
orwell_engine = importlib.import_module("src.orwell_engine")


@pytest.fixture(autouse=True)
def _ws_env(tmp_path, monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setattr(ogs, "GAME_SESSION_PATH", tmp_path / "orwell_game_session.json")
    monkeypatch.setattr(ws_routes, "_is_live", lambda sid: True)
    H.reset_runs()
    yield
    H.reset_runs()
    ws_routes.set_turn_stream_factory(None)


def _set_beat(monkeypatch, cur: int):
    async def _state(user):
        return {"started": True, "beatSeq": cur}
    monkeypatch.setattr(ws_routes, "_engine_state", _state)


# ── decision up-frame: the real engine CAS ────────────────────────────────────────────────────────

def test_decision_stale_beat_is_refused_without_write(run, monkeypatch):
    _set_beat(monkeypatch, cur=42)
    calls = {"submit": 0}

    async def _submit(decision, expected_beat_seq=None, idempotency_key=None, user=None):
        calls["submit"] += 1
        # the engine CAS: a token that doesn't match the current beat is refused BEFORE any write
        if expected_beat_seq is not None and expected_beat_seq != 42:
            raise orwell_engine.EngineToolError(
                "stale write refused (now 42)", status=409, code="stale-beat", beat_seq=42)
        return {"beatSeq": 43, "pending": None}

    monkeypatch.setattr(orwell_engine, "submit_decision", _submit)

    async def main():
        canon = H.seed_live_game(None, "live-canon")
        ws = H.new_ws(); t = H.spawn(ws)
        await H.hello(ws, canon)
        # stale token (client computed against beat 40; board is now 42)
        ws.client_send({"t": "decision", "ch": "chat", "cid": "c_dec",
                        "d": {"kind": "nominations", "targets": ["npc_1", "npc_2"], "expectedBeatSeq": 40}})
        err = await ws.recv_where(lambda f: f.get("t") == "error")
        assert err["cid"] == "c_dec"
        assert err["d"]["code"] == "stale-beat"
        assert err["d"]["beatSeq"] == 42        # the fresh beat the client reconciles to
        assert calls["submit"] == 1             # the engine was asked, and it refused before writing
        await H.stop(ws, t)

    run(main())


def test_decision_fresh_beat_proceeds_and_acks(run, monkeypatch):
    _set_beat(monkeypatch, cur=42)

    async def _submit(decision, expected_beat_seq=None, idempotency_key=None, user=None):
        assert expected_beat_seq == 42          # the WS carried the client's fresh token forward
        # the sync-spine tokens are pulled OUT of the decision payload (not engine fields)
        assert "expectedBeatSeq" not in decision and "idempotencyKey" not in decision
        assert decision["kind"] == "veto-decision"
        return {"beatSeq": 43, "pending": None}

    monkeypatch.setattr(orwell_engine, "submit_decision", _submit)

    async def main():
        canon = H.seed_live_game(None, "live-canon")
        ws = H.new_ws(); t = H.spawn(ws)
        await H.hello(ws, canon)
        ws.client_send({"t": "decision", "ch": "chat", "cid": "c_ok",
                        "d": {"kind": "veto-decision", "choice": "use", "target": "npc_3",
                              "expectedBeatSeq": 42, "idempotencyKey": "idem-1"}})
        ack = await ws.recv_where(lambda f: f.get("t") == "ack" and f.get("cid") == "c_ok")
        assert ack["d"]["accepted"] is True
        # a state edge follows so every window re-reads the moved board
        st = await ws.recv_where(lambda f: f.get("t") == "state")
        assert st["d"]["beatSeq"] == 43
        await H.stop(ws, t)

    run(main())


# ── turn up-frame: the pre-flight CAS guard ───────────────────────────────────────────────────────

def test_turn_stale_beat_is_admitted_and_the_ack_carries_the_current_beat(run, monkeypatch):
    """ORW-941 (protocol §3.5 amended): a `turn` token is advisory. A stale turn is ADMITTED (casting write-backs move the beatSeq with no edge to the page, and a refusing CAS
    dropped casting turns), and its ack hands the page the current beatSeq. `decision` keeps the refusing CAS."""
    _set_beat(monkeypatch, cur=10)
    started = {"factory": 0}

    def _factory(d, canonical, user):
        started["factory"] += 1
        async def _agen():
            yield H.sse_done()
        return _agen()

    ws_routes.set_turn_stream_factory(_factory)

    async def main():
        canon = H.seed_live_game(None, "live-canon")
        ws = H.new_ws(); t = H.spawn(ws)
        await H.hello(ws, canon)
        ws.client_send({"t": "turn", "ch": "chat", "cid": "c_turn",
                        "d": {"message": "I pull them aside", "expectedBeatSeq": 8}})  # stale (< 10)
        ack = await ws.recv_where(lambda f: f.get("cid") == "c_turn")
        assert ack["t"] == "ack" and ack["d"]["accepted"] is True, ack
        assert ack["d"]["beatSeq"] == 10                     # the page catches up
        assert started["factory"] == 1                      # the turn runs
        await H.stop(ws, t)

    run(main())


def test_turn_fresh_beat_starts_the_run_and_acks(run, monkeypatch):
    _set_beat(monkeypatch, cur=10)
    seen = {}

    def _factory(d, canonical, user):
        seen["d"] = d
        seen["canonical"] = canonical
        async def _agen():
            yield H.sse_delta("scene")
            yield H.sse_done()
        return _agen()

    ws_routes.set_turn_stream_factory(_factory)

    async def main():
        canon = H.seed_live_game(None, "live-canon")
        ws = H.new_ws(); t = H.spawn(ws)
        await H.hello(ws, canon)
        ws.client_send({"t": "turn", "ch": "chat", "cid": "c_turn",
                        "d": {"message": "hey", "expectedBeatSeq": 10}})   # fresh
        ack = await ws.recv_where(lambda f: f.get("t") == "ack" and f.get("cid") == "c_turn")
        assert ack["d"]["accepted"] is True
        assert seen["canonical"] == canon                   # relayed onto the canonical run key
        assert ws_routes.agent_runs.has_run(canon)          # the run was started (queue-don't-cancel)
        await H.stop(ws, t)
        await H.aclose_runs()

    run(main())


def test_turn_relay_unwired_is_explicit_not_silent(run, monkeypatch):
    """With no factory registered the turn relay must answer with an explicit error, NEVER a silent
    no-op (the deferred-content leg is visible, not swallowed)."""
    _set_beat(monkeypatch, cur=10)
    ws_routes.set_turn_stream_factory(None)

    async def main():
        canon = H.seed_live_game(None, "live-canon")
        ws = H.new_ws(); t = H.spawn(ws)
        await H.hello(ws, canon)
        ws.client_send({"t": "turn", "ch": "chat", "cid": "c_turn", "d": {"message": "hi"}})
        err = await ws.recv_where(lambda f: f.get("t") == "error")
        assert err["cid"] == "c_turn"
        assert err["d"]["code"] == "turn-relay-unwired"
        await H.stop(ws, t)

    run(main())

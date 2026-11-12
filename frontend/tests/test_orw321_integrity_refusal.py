"""ORW-321: an integrity-checkpoint refusal (HTTP 409 `code: "turn-refused"`) must never fail silently. The FE (1) raises a TYPED EngineTurnRefused (never retried: the engine answered), (2) records a standing RED
refusal (kinds + the invariant NAME only) that reaches the engine-health detail and the overseer ring, (3) hands the narrator an honest production note in the tool error so the player gets one short out-of-fiction
line instead of a frozen scene, (4) stands the advance stall/force belts down while the refusal is recent (it is not a model stall), and (5) clears the standing refusal on the next successful mutating call.
Name-agnostic; the engine is a scripted client (real httpx.Response objects). No model."""
import importlib
import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_orwell_engine_resilience import _SeqClient, _patch_seq, _resp, _run  # noqa: E402,F401

orwell_engine = importlib.import_module("src.orwell_engine")
pytestmark = pytest.mark.engine_retry  # prove a refusal is NOT retried even with the retry ON

REFUSAL = {"error": "turn refused — integrity checkpoint failed (degradation); state unchanged",
           "code": "turn-refused", "kinds": ["degradation"], "invariant": "sessionCore.deals"}


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    async def _no_sleep(_s):
        return None
    monkeypatch.setattr(orwell_engine.asyncio, "sleep", _no_sleep)
    orwell_engine._INTEGRITY_REFUSAL.clear()
    orwell_engine._REFUSED_TURN.clear()
    orwell_engine._clear_error()
    orwell_engine._client = None
    orwell_engine._client_factory = None
    yield
    orwell_engine._INTEGRITY_REFUSAL.clear()
    orwell_engine._REFUSED_TURN.clear()
    orwell_engine._clear_error()
    orwell_engine._client = None
    orwell_engine._client_factory = None


def test_a_refusal_is_typed_not_retried_and_names_the_invariant(monkeypatch):
    client = _patch_seq(monkeypatch, [_resp(409, payload=REFUSAL)])
    with pytest.raises(orwell_engine.EngineTurnRefused) as ei:
        _run(orwell_engine.advance_game(user="u"))
    e = ei.value
    assert client.calls == 1                       # the engine ANSWERED - never retried
    assert e.kinds == ["degradation"] and e.invariant == "sessionCore.deals" and e.status == 409 and e.code == "turn-refused"
    assert "integrity checkpoint failed" in str(e)  # the markers other layers key on survive


def test_the_tool_error_carries_an_honest_line_for_the_player(monkeypatch):
    _patch_seq(monkeypatch, [_resp(409, payload=REFUSAL)])
    with pytest.raises(orwell_engine.EngineTurnRefused) as ei:
        _run(orwell_engine.advance_game(user="u"))
    msg = str(ei.value)
    assert "PRODUCTION NOTE" in msg and "ONE short out-of-character line" in msg and "operator has been told" in msg
    assert "do not retry" in msg.lower()


def test_a_refusal_is_a_standing_red_signal_vault_free(monkeypatch):
    _patch_seq(monkeypatch, [_resp(409, payload=REFUSAL)])
    with pytest.raises(orwell_engine.EngineTurnRefused):
        _run(orwell_engine.advance_game(user="u"))
    r = orwell_engine.integrity_refusal("u")
    assert r and r["tool"] == "advanceGame" and r["kinds"] == ["degradation"] and r["invariant"] == "sessionCore.deals" and r["count"] == 1
    assert orwell_engine.integrity_refusal_recent("u") is True
    assert orwell_engine.refused_this_turn("u") is True
    # the red entry reaches the engine-health detail the admin page and the player banner read
    async def _probe():
        return {"ok": True, "engineUrl": "x"}
    monkeypatch.setattr(orwell_engine, "_probe_health_once", _probe)
    detail = _run(orwell_engine.engine_health_detail())
    ir = detail.get("integrityRefusal")
    assert ir and ir["red"] is True and ir["invariant"] == "sessionCore.deals" and ir["count"] == 1
    assert set(ir) == {"red", "tool", "kinds", "invariant", "count", "ageSeconds"}  # names, kinds, a count: nothing else


def test_per_turn_flag_clears_but_the_standing_refusal_persists_until_a_success(monkeypatch):
    _patch_seq(monkeypatch, [_resp(409, payload=REFUSAL)])
    with pytest.raises(orwell_engine.EngineTurnRefused):
        _run(orwell_engine.advance_game(user="u"))
    orwell_engine.clear_disclosure_turn("u")        # the next turn's framing
    assert orwell_engine.refused_this_turn("u") is False
    assert orwell_engine.integrity_refusal_recent("u") is True
    _patch_seq(monkeypatch, [_resp(200, payload={"result": {"started": True}})])
    _run(orwell_engine.advance_game(user="u"))      # a mutating call went through
    assert orwell_engine.integrity_refusal("u") is None


def test_the_standing_refusal_expires_so_a_later_attempt_can_prove_the_fix(monkeypatch):
    _patch_seq(monkeypatch, [_resp(409, payload=REFUSAL)])
    with pytest.raises(orwell_engine.EngineTurnRefused):
        _run(orwell_engine.advance_game(user="u"))
    orwell_engine._INTEGRITY_REFUSAL["u"]["last"] -= 601
    assert orwell_engine.integrity_refusal_recent("u") is False


def test_a_stale_beat_409_is_not_an_integrity_refusal(monkeypatch):
    _patch_seq(monkeypatch, [_resp(409, payload={"error": "stale beat", "code": "stale-beat", "beatSeq": 5, "board": {}})])
    with pytest.raises(orwell_engine.EngineToolError) as ei:
        _run(orwell_engine.advance_game(user="u"))
    assert not isinstance(ei.value, orwell_engine.EngineTurnRefused)
    assert orwell_engine.integrity_refusal("u") is None


def test_the_advance_belts_stand_down_and_the_surfaces_render_it():
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    loop = open(os.path.join(base, "src", "agent_loop.py"), encoding="utf-8").read()
    assert "_oe_ir.integrity_refusal_recent(owner)" in loop and "_want_advance = False" in loop.split("_oe_ir.integrity_refusal_recent(owner)")[1][:200]
    admin = open(os.path.join(base, "routes", "admin_health_routes.py"), encoding="utf-8").read()
    assert 'frontend["integrityRefusal"]' in admin and "integrity checkpoint is REFUSING turns" in admin
    banner = open(os.path.join(base, "static", "js", "orwellEngineStatus.js"), encoding="utf-8").read()
    assert "d.integrityRefusal" in banner

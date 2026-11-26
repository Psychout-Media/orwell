"""ORW-969 - server-side casting jobs read the FULL cast through the engine's `pipelineCast`, never the met-only roster.

Since ORW-710 the engine's public `getGameState` lists only the houseguests who have walked in during the premiere and counts the rest in `unarrivedCount`. That is right for the browser and the
narrator; the house-entry gate (ORW-948 patched it by subtracting the unarrived from the threshold, so they were never checked), the habits step (ORW-949 made it wait) and the authoring backfills
were left blind to the rest of the cast. Pinned here:
  - `pipeline_cast_for` returns the engine's full read, `{"started": False}` for no game, and None for any failure or odd shape;
  - `authoring_completeness_for` / `await_house_ready` count every houseguest and compare the FULL authored count with the threshold (no subtraction); an unarrived houseguest on the floor holds the gate;
  - when the read is unavailable the ORW-948 arithmetic and the ORW-949 wait are exactly as before;
  - `run_words` runs on the full cast at once (no wait); unavailable => it waits as before;
  - the straggler backfill finds and authors a houseguest who has not arrived;
  - the browser routes never call the read and never carry the unarrived names; the narrator has no tool for it.

Roles only - every name is a generic probe, never cast material.
"""
import importlib
import json
import pathlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from conftest import _run

ca = importlib.import_module("src.orwell_cast_authoring")
oe = importlib.import_module("src.orwell_engine")
w = importlib.import_module("src.orwell_npc_minds_words")
orwell_routes = importlib.import_module("routes.orwell_routes")

_FULL = ca.HOUSE_READY_MIN_AUTHORED
HIDDEN = "Unarrived Probe"  # the name of a houseguest who has not walked in yet


def _hg(i, *, authored=True, name=None):
    return {"id": f"npc:{i}", "name": name or f"Houseguest {i}", "status": "active", "authored": authored,
            "biography": "Grew up near the water and still fixes boats.", "identityConcept": "a boat-fixer who reads a room",
            "physicalCharacteristics": {"wardrobe": ["tee"], "onCamera": "arms folded", "photoHair": "short"}}


def _met_only(n_arrived, total=_FULL):
    return {"started": True, "player": {"id": "player", "name": "The Player", "status": "active"},
            "house": [_hg(i) for i in range(1, n_arrived + 1)], "unarrivedCount": total - n_arrived}


def _full(n_authored, total=_FULL):
    return {"started": True, "total": total, "unarrivedCount": total - 7,
            "house": [_hg(i, authored=i <= n_authored, name=(HIDDEN if i == total else None)) for i in range(1, total + 1)]}


def _stub(monkeypatch, *, state=None, pipeline=None, pipeline_raises=False, calls=None):
    async def fake_state(user=None, **k):
        if calls is not None:
            calls.append("state")
        return state

    async def fake_pipe(user=None, **k):
        if calls is not None:
            calls.append("pipe")
        if pipeline_raises:
            raise oe.EngineToolError("unknown tool pipelineCast", status=404)
        return pipeline
    monkeypatch.setattr(oe, "get_game_state", fake_state)
    monkeypatch.setattr(oe, "pipeline_cast", fake_pipe)


async def _noop():
    return None


# -- the helper -------------------------------------------------------------------------------------------------------------

def test_helper_returns_the_full_read_no_game_and_none_for_failures(monkeypatch):
    full = _full(15)
    _stub(monkeypatch, pipeline=full)
    assert _run(ca.pipeline_cast_for("u")) == full
    _stub(monkeypatch, pipeline={"started": False})
    assert _run(ca.pipeline_cast_for("u")) == {"started": False}
    _stub(monkeypatch, pipeline_raises=True)
    assert _run(ca.pipeline_cast_for("u")) is None
    for odd in (None, [], {"house": "x", "unarrivedCount": 1}, {"house": [], "unarrivedCount": "1"}, {"house": [], "unarrivedCount": True}, {"error": "x"}):
        _stub(monkeypatch, pipeline=odd)
        assert _run(ca.pipeline_cast_for("u")) is None, odd


# -- the gate ----------------------------------------------------------------------------------------------------------------

def test_completeness_counts_every_houseguest_including_the_unarrived(monkeypatch):
    """Seven in, eight outside, ALL fifteen authored: the full cast is counted and no `unarrived` allowance rides along."""
    _stub(monkeypatch, state=_met_only(7), pipeline=_full(15))
    comp = _run(ca.authoring_completeness_for("u"))
    assert comp["total"] == 15 and comp["authored"] == 15 and comp["missing"] == 0
    assert "unarrived" not in comp


def test_gate_compares_the_full_authored_count_with_the_threshold(monkeypatch):
    """The old arithmetic passed 7/7 arrived with 8 never checked. Now a floor houseguest who has not arrived holds the gate (13 of 15 authored), and 15 of 15 opens it."""
    monkeypatch.setattr(ca, "_kick_backfill_for_stragglers", lambda owner: _noop())
    _stub(monkeypatch, state=_met_only(7), pipeline=_full(13))
    out = _run(ca.await_house_ready("u", timeout=0.05, poll_interval=0.01))
    assert out["ready"] is False and out["authored"] == 13 and out["missing"] == 2
    _stub(monkeypatch, state=_met_only(7), pipeline=_full(15))
    out = _run(ca.await_house_ready("u", timeout=0.05, poll_interval=0.01))
    assert out["ready"] is True and out["authored"] == 15 and out["total"] == 15


def test_gate_falls_back_to_the_orw948_arithmetic_when_the_read_is_unavailable(monkeypatch):
    """An engine without the read: 7 of 7 arrived authored, 8 withheld => ready (today's behaviour); one arrived houseguest on the floor => held."""
    monkeypatch.setattr(ca, "_kick_backfill_for_stragglers", lambda owner: _noop())
    _stub(monkeypatch, state=_met_only(7), pipeline_raises=True)
    out = _run(ca.await_house_ready("u", timeout=0.05, poll_interval=0.01))
    assert out["ready"] is True and out["authored"] == 7 and out["unarrived"] == _FULL - 7
    st = _met_only(7)
    st["house"][0]["authored"] = False
    _stub(monkeypatch, state=st, pipeline_raises=True)
    out = _run(ca.await_house_ready("u", timeout=0.05, poll_interval=0.01))
    assert out["ready"] is False


def test_completeness_is_none_for_a_no_game_user(monkeypatch):
    _stub(monkeypatch, state={"started": False}, pipeline={"started": False})
    assert _run(ca.authoring_completeness_for("u")) is None


# -- the straggler backfill --------------------------------------------------------------------------------------------------

def test_backfill_reaches_a_houseguest_who_has_not_arrived(monkeypatch):
    seen = {}

    async def fake_run_authoring(subset, user, on_authored=None):
        seen["ids"] = [h["id"] for h in subset]
        return len(subset)
    monkeypatch.setattr(ca, "run_authoring", fake_run_authoring)
    _stub(monkeypatch, state=_met_only(7), pipeline=_full(14))
    assert _run(ca.backfill_unauthored(["npc:15"], "u")) == 1
    assert seen["ids"] == ["npc:15"], "the unarrived floor houseguest is found on the full cast"
    seen.clear()
    _stub(monkeypatch, state=_met_only(7), pipeline_raises=True)  # control: the met-only read cannot see them (today's behaviour)
    assert _run(ca.backfill_unauthored(["npc:15"], "u")) == 0 and "ids" not in seen


def test_straggler_kick_uses_the_full_cast(monkeypatch):
    kicked = []
    monkeypatch.setattr(ca, "kickoff_authoring_backfill", lambda ids, owner, force=False: kicked.append(list(ids)))
    _stub(monkeypatch, state=_met_only(7), pipeline=_full(14))
    _run(ca._kick_backfill_for_stragglers("u"))
    assert kicked == [["npc:15"]]


# -- the habits / house culture step -----------------------------------------------------------------------------------------

def _words_env(monkeypatch, *, state, pipeline=None, pipeline_raises=False):
    alerts, seen = [], {"state_reads": 0}
    monkeypatch.setattr(w, "_alert", lambda owner, key, what: alerts.append(key))

    async def resolve(owner):
        async def llm(msgs):
            return json.dumps({"habits": ["gym-rat", "early-riser"], "aimHint": "win-by-comps", "aimWhy": "a former sprinter"})
        return llm
    monkeypatch.setattr(ca, "_resolve_llm_fn", resolve)

    async def fake_state(user=None, **k):
        seen["state_reads"] += 1
        return state

    async def fake_pipe(user=None, **k):
        if pipeline_raises:
            raise oe.EngineToolError("unknown tool pipelineCast", status=404)
        return pipeline

    async def rec_traits(req, user=None):
        seen["traits"] = req
        return {"accepted": True}

    async def rec_culture(req, user=None):
        seen["culture"] = req
        return {"accepted": True}
    monkeypatch.setattr(oe, "get_game_state", fake_state)
    monkeypatch.setattr(oe, "pipeline_cast", fake_pipe)
    monkeypatch.setattr(oe, "record_npc_traits", rec_traits)
    monkeypatch.setattr(oe, "record_house_culture", rec_culture)
    monkeypatch.setenv("ORWELL_NPC_MINDS_CAST_WAIT_S", "0.01")
    monkeypatch.setenv("ORWELL_NPC_MINDS_CAST_BUDGET_S", "0.05")
    return seen, alerts


def test_words_run_on_the_full_cast_at_once(monkeypatch):
    seen, alerts = _words_env(monkeypatch, state=_met_only(7), pipeline=_full(15))
    _run(w.run_words("w1"))
    assert len(seen["traits"]["traits"]) == 15, "habits cover the unarrived too"
    assert seen["state_reads"] == 0, "no met-only read and no wait"
    assert "npc-minds:partial-cast" not in alerts


def test_words_fall_back_to_the_orw949_wait_when_the_read_is_unavailable(monkeypatch):
    seen, alerts = _words_env(monkeypatch, state=_met_only(7), pipeline_raises=True)
    _run(w.run_words("w2"))
    assert alerts.count("npc-minds:partial-cast") == 1, "the bounded wait ran and gave up with its alert"
    assert len(seen["traits"]["traits"]) == 7 and seen["state_reads"] > 1


# -- the walls: nothing forwards it to the browser or the narrator ---------------------------------------------------------------

@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(orwell_routes.setup_orwell_routes())
    return TestClient(app)


def test_browser_routes_never_carry_the_pipeline_read(client, monkeypatch):
    called = []

    async def fake_pipe(user=None, **k):
        called.append(1)
        return _full(15)

    async def fake_polled(user=None, timeout=None):
        return _met_only(7)

    async def fake_status(user=None, **k):
        return {"started": True, "beatSeq": 3, "week": 0, "phase": "premiere"}
    monkeypatch.setattr(oe, "pipeline_cast", fake_pipe)
    monkeypatch.setattr(oe, "get_game_state_polled", fake_polled)
    monkeypatch.setattr(oe, "game_status_polled", fake_status)
    bodies = []
    for path in ("/api/orwell/state", "/api/orwell/status"):
        r = client.get(path)
        assert r.status_code == 200, (path, r.text)
        bodies.append(r.text)
    assert not called, "no browser route may read the pipeline cast"
    assert HIDDEN not in "".join(bodies), "an unarrived houseguest's name reached the browser"
    state = json.loads(bodies[0])
    assert state["unarrivedCount"] == _FULL - 7 and len(state["house"]) == 7, "the browser still gets the met-only roster and the count"
    assert "total" not in state


def test_projection_drops_the_pipeline_keys():
    out = orwell_routes._browser_state_projection(dict(_full(15), player={"id": "player", "name": "The Player", "status": "active"}))
    assert "total" not in out
    for hg in out["house"]:
        assert set(hg) <= {"id", "name", "status", "evictedSeq", "lastSeenMood"}


_FE = pathlib.Path(__file__).resolve().parents[1]


def test_no_route_and_no_narrator_surface_references_the_read():
    """Static wall: only the casting module and the engine client name it; no route, no tool schema, no tool dispatch."""
    hits = {p.relative_to(_FE).as_posix() for sub in ("src", "routes") for p in (_FE / sub).rglob("*.py")
            if "pipelineCast" in p.read_text("utf-8", "ignore") or "pipeline_cast" in p.read_text("utf-8", "ignore")}
    assert hits == {"src/orwell_engine.py", "src/engine_read_cache.py", "src/orwell_cast_authoring.py", "src/orwell_npc_minds_words.py"}, hits
    assert "pipelineCast" not in (_FE / "src" / "tool_schemas.py").read_text("utf-8"), "the narrator has no schema for it"
    assert "pipelineCast" not in (_FE / "src" / "tool_execution.py").read_text("utf-8")

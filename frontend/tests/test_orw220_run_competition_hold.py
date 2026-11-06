"""ORW-220: the model's runCompetition PREVIEWS the current competition (type/name/winner). While production holds a not-yet-due scheduled event it must return `held` with NO outcome and
never call the engine, exactly like advanceGame. Outside a hold it is unchanged. Roles only. SYNC tests."""
import asyncio
import importlib
import json

ti = importlib.import_module("src.tool_implementations")
orwell_engine = importlib.import_module("src.orwell_engine")
ch = importlib.import_module("routes.chat_helpers")

PREVIEW = {"started": True, "type": "social", "week": 1, "phase": "hoh-competition",
           "winner": {"id": "npc:2", "name": "A Houseguest"}, "name": "A Comp", "format": "social"}


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _hold(owner):
    ch._PRODUCTION_HOLD[ch._runway_key(owner)] = ("sig", 1)


def _release(owner):
    ch._PRODUCTION_HOLD.pop(ch._runway_key(owner), None)


def test_run_competition_is_held_with_no_outcome_during_a_production_hold(monkeypatch):
    calls = []

    async def fake(ctype, ids, user=None):
        calls.append(ctype)
        return dict(PREVIEW)

    monkeypatch.setattr(orwell_engine, "run_competition", fake)
    _hold("o1")
    try:
        out = _run(ti.do_run_competition('{"type":"social"}', owner="o1"))
    finally:
        _release("o1")
    body = json.loads(out["output"])
    assert out["exit_code"] == 0 and body["held"] is True
    assert calls == [], "the engine must not be called (no preview) while production holds the comp"
    for leaked in ("winner", "type", "name", "format", "narrative"):
        assert leaked not in body
    assert "A Houseguest" not in out["output"] and "A Comp" not in out["output"]


def test_run_competition_is_unchanged_when_nothing_is_held(monkeypatch):
    async def fake(ctype, ids, user=None):
        return dict(PREVIEW)

    monkeypatch.setattr(orwell_engine, "run_competition", fake)
    _release("o2")
    out = _run(ti.do_run_competition('{"type":"social"}', owner="o2"))
    assert json.loads(out["output"])["winner"]["id"] == "npc:2"


def test_the_hold_is_per_player(monkeypatch):
    async def fake(ctype, ids, user=None):
        return dict(PREVIEW)

    monkeypatch.setattr(orwell_engine, "run_competition", fake)
    _hold("o3")
    try:
        out = _run(ti.do_run_competition("{}", owner="o4"))
    finally:
        _release("o3")
    assert "held" not in json.loads(out["output"])

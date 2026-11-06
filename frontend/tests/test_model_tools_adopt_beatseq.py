"""Follow-up to ORW-188: every MODEL-driven tool that commits in the engine adopts the post-commit beatSeq it echoes, so the next mutating call in the same turn is not a self-inflicted stale-beat 409.
One parametrized case per tool (moveTo, makeDeal, surfaceInformationTo, confide, exposeSecret, tradeSecret, confront) + a "no echo leaves the token alone" case. Roles only. SYNC."""
import asyncio
import importlib

import pytest

importlib.import_module("src.agent_tools")  # import order: tool_schemas <-> agent_tools is circular when tool_schemas loads first
ti = importlib.import_module("src.tool_implementations")
orwell_engine = importlib.import_module("src.orwell_engine")
ch = importlib.import_module("routes.chat_helpers")

CASES = [
    ("do_move_to", "move_to", '{"room":"kitchen"}'),
    ("do_make_deal", "make_deal", '{"with":"npc:1","kind":"safety","terms":"we stick together"}'),
    ("do_surface_information", "surface_information", '{"information":"a fact","pathway":"overheard"}'),
    ("do_confide", "confide", '{"npcId":"npc:1"}'),
    ("do_expose_secret", "expose_secret", '{"factId":"f1"}'),
    ("do_trade_secret", "trade_secret", '{"toNpcId":"npc:1","factId":"f1"}'),
    ("do_confront", "confront", '{"npcId":"npc:1","factId":"f1"}'),
    ("do_update_casting", "update_casting", '{"name":"The Player"}'),
]


def _run(coro):
    return asyncio.run(coro)


def _fake(result):
    async def fake(*a, **k):
        return result
    return fake


@pytest.mark.parametrize("tool,engine_fn,args", CASES)
def test_the_tool_adopts_the_echoed_token(monkeypatch, tool, engine_fn, args):
    ch._LAST_BEAT_SEQ.clear()
    ch._refresh_beat_seq("o1", {"beatSeq": 10})
    monkeypatch.setattr(orwell_engine, engine_fn, _fake({"ok": True, "status": "moved", "beatSeq": 11}))
    out = _run(getattr(ti, tool)(args, owner="o1"))
    assert out.get("exit_code") == 0, out
    assert ch.last_beat_seq("o1") == 11, f"{tool} left a stale token"


@pytest.mark.parametrize("tool,engine_fn,args", CASES)
def test_a_result_without_a_token_leaves_it_alone(monkeypatch, tool, engine_fn, args):
    ch._LAST_BEAT_SEQ.clear()
    ch._refresh_beat_seq("o2", {"beatSeq": 10})
    monkeypatch.setattr(orwell_engine, engine_fn, _fake({"ok": True}))
    _run(getattr(ti, tool)(args, owner="o2"))
    assert ch.last_beat_seq("o2") == 10


def test_move_to_returning_none_leaves_the_token_alone(monkeypatch):
    ch._LAST_BEAT_SEQ.clear()
    ch._refresh_beat_seq("o3", {"beatSeq": 10})
    monkeypatch.setattr(orwell_engine, "move_to", _fake(None))
    out = _run(ti.do_move_to('{"room":"kitchen"}', owner="o3"))
    assert out["exit_code"] == 0 and "No game" in out["output"]
    assert ch.last_beat_seq("o3") == 10


def test_a_refused_make_deal_never_calls_the_engine_and_leaves_the_token_alone(monkeypatch):
    ch._LAST_BEAT_SEQ.clear()
    ch._refresh_beat_seq("o4", {"beatSeq": 10})
    called = []

    async def fake(*a, **k):
        called.append(1)
        return {"beatSeq": 99}

    monkeypatch.setattr(orwell_engine, "make_deal", fake)
    out = _run(ti.do_make_deal('{"with":"npc:1","kind":"not-a-kind","terms":"x"}', owner="o4"))  # refused before any engine call
    assert out["exit_code"] == 1 and not called
    assert ch.last_beat_seq("o4") == 10


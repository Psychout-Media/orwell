"""ORW-706 - a REFUSED scene record is not a recorded scene.

Dev playtest: the model called recordInteraction six times in one turn and the engine refused every call (exit_code 1; beatSeq never moved). Three seams counted the refused calls by NAME as "the model recorded":
the in-loop 0055 belt stood down, the loop's landed-tool set said "recorded", and the E22 end-of-turn guard stood down ("turn wrote [recordInteraction x6]"). The player's promise was never folded.
A refused call now cancels exactly one call of that name; the belt/guard fire as for any under-call.
"""
import asyncio
import importlib
import re
from pathlib import Path

import pytest

chat_helpers = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")
fold_ledger = importlib.import_module("src.fold_ledger")
agent_loop = importlib.import_module("src.agent_loop")

NARRATION = "The yard is warm and loud, and the player holds a houseguest's hands in both of theirs, promising to keep their name off the block this week. " * 3
FE = Path(__file__).resolve().parent.parent


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


@pytest.fixture(autouse=True)
def _clean():
    chat_helpers._fallback_in_flight.clear(); fold_ledger.clear_all()
    yield
    chat_helpers._fallback_in_flight.clear(); fold_ledger.clear_all()


def _spy(monkeypatch):
    calls = []

    async def rec(*a, **k):
        calls.append((a, k)); return {"ok": True}
    monkeypatch.setattr(orwell_engine, "record_interaction", rec)

    async def declined(user, player_message, narration):
        return False
    monkeypatch.setattr(chat_helpers, "_e22_rich_extract", declined)
    return calls


def test_e22_guard_does_not_stand_down_for_refused_record_calls(monkeypatch):
    calls = _spy(monkeypatch)
    tools = ["recordInteraction", "npcVoice"] * 3
    _run(chat_helpers.ensure_turn_recorded("u", "I promise I will not put you up.", NARRATION, tools, failed_tools=["recordInteraction"] * 3))
    assert len(calls) == 1  # the floor fold ran: the promise is recorded


def test_e22_guard_still_stands_down_when_a_record_landed(monkeypatch):
    calls = _spy(monkeypatch)
    tools = ["recordInteraction", "recordInteraction"]
    out = _run(chat_helpers.ensure_turn_recorded("u", "I promise.", NARRATION, tools, failed_tools=["recordInteraction"]))
    assert out is False and calls == []  # one refused, one landed: a real write stands


def test_landed_tool_events_drops_a_refused_record_but_keeps_other_failures():
    refused = {"tool": "recordInteraction", "exit_code": 1}
    landed = {"tool": "recordInteraction", "exit_code": 0}
    other = {"tool": "advanceGame", "exit_code": 1}
    got = agent_loop._landed_tool_events([refused, landed, other])
    assert refused not in got and landed in got and other in got
    assert not ({e["tool"] for e in agent_loop._landed_tool_events([refused])} & agent_loop._RECORD_TOOLS)


def test_in_loop_belt_stays_armed_after_a_refused_record():
    src = (FE / "src" / "agent_loop.py").read_text()
    m = re.search(r"if \(_is_live_game and block\.tool_type in _RECORD_TOOLS\s*\n\s*and \(not isinstance\(result, dict\) or result\.get\(\"exit_code\"\) in \(None, 0\)\)\):\s*\n\s*_turn_record_nudges = 1", src)
    assert m, "a refused record must not set _turn_record_nudges"


def test_chat_route_collects_failed_tool_outputs_and_passes_them():
    src = (FE / "routes" / "chat_routes.py").read_text()
    assert "_agent_tools_failed.append" in src and "failed_tools=_agent_tools_failed" in src

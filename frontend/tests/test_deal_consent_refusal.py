"""Engine-side NPC deal consent (ORWELL_NPC_DEAL_CONSENT): the ENGINE decides whether the NPC agrees to a player's deal.

A refusal reaches the narrator as "the NPC declined: <reason>" (never a silent success), and the deal back-fill belt treats it
as "no deal" and never retries. These run the real tool path: `do_make_deal` -> `orwell_engine.make_deal` -> the engine call
(patched at the HTTP transport only) -> `format_tool_result`, the exact text the narrator sees.
"""
import asyncio
import importlib
import json

importlib.import_module("src.agent_tools")  # prime the agent_tools <-> tool_schemas import cycle
import src.orwell_engine as oe  # noqa: E402
import src.tool_implementations as ti  # noqa: E402
import src.agent_loop as al  # noqa: E402
import src.llm_core as llm_core  # noqa: E402
from src.tool_execution import format_tool_result  # noqa: E402

REFUSAL = {"refused": True, "reason": "distrust", "narratable": "doesn't trust you enough yet to shake on this"}
DEAL = {"id": "deal:1", "kind": "safety", "terms": "t", "status": "open", "parties": []}
HOUSE = [{"id": "npc:3", "name": "Cynthia Hawkins"}, {"id": "npc:7", "name": "Tobias Drake"}]


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _engine(monkeypatch, reply):
    """Patch ONLY the transport: the real make_deal builds the args and the real do_make_deal shapes the result."""
    calls = []

    async def _post(path, name, args, user, timeout=None):
        calls.append((name, args))
        return reply

    monkeypatch.setattr(oe, "_post_tool", _post)
    return calls


def test_refusal_reaches_the_narrator_as_a_decline(monkeypatch):
    _engine(monkeypatch, REFUSAL)
    res = _run(ti.do_make_deal(json.dumps({"with": "npc:3", "kind": "safety", "terms": "we protect each other"}), owner="u"))
    assert res["exit_code"] == 0
    seen = format_tool_result("makeDeal", res)
    assert "declined" in seen.lower()
    assert "doesn't trust you enough yet" in seen
    assert "No deal was made" in seen
    # it must NOT look like a recorded deal (no deal id / status the narrator could mistake for success)
    assert '"status"' not in seen and "deal:" not in seen


def test_an_accepted_deal_is_unchanged(monkeypatch):
    _engine(monkeypatch, DEAL)
    res = _run(ti.do_make_deal(json.dumps({"with": "npc:3", "kind": "safety", "terms": "we protect each other"}), owner="u"))
    assert res["exit_code"] == 0
    assert json.loads(res["output"]) == DEAL
    assert "declined" not in format_tool_result("makeDeal", res).lower()


def test_is_deal_refusal_is_strict():
    assert ti.is_deal_refusal(REFUSAL)
    assert not ti.is_deal_refusal(DEAL)
    assert not ti.is_deal_refusal(None)
    assert not ti.is_deal_refusal({"refused": "yes"})
    assert not ti.is_deal_refusal({"refused": False})


def _belt(monkeypatch, reply):
    calls = _engine(monkeypatch, reply)

    async def fake_llm(*a, **k):
        return '{"struck":true,"withId":"npc:3","kind":"safety","terms":"neither nominates the other"}'

    monkeypatch.setattr(llm_core, "llm_call_async", fake_llm)
    return calls


def test_the_belt_does_not_record_a_refused_deal_and_does_not_retry(monkeypatch):
    calls = _belt(monkeypatch, REFUSAL)
    out = _run(al._auto_record_deal("I shake Cynthia's hand on a no-nominate pact.", "deal with Cynthia", HOUSE, "url", "m", {}, "owner"))
    assert out is False, "a refusal is NOT a recorded deal"
    assert [c[0] for c in calls].count("makeDeal") == 1, "the belt asked once and did not retry"


def test_the_belt_still_records_an_accepted_deal(monkeypatch):
    calls = _belt(monkeypatch, DEAL)
    out = _run(al._auto_record_deal("I shake Cynthia's hand on a no-nominate pact.", "deal with Cynthia", HOUSE, "url", "m", {}, "owner"))
    assert out is True
    assert [c[0] for c in calls].count("makeDeal") == 1

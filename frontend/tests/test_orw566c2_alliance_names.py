"""ORW-566 part c2 (spec 0183): formation-time alliance naming through the anonymized sealed-prompt door, FE side.

The engine hands over ``{ticket, prompt}`` only (a fixed-size batch once a night, real and decoy tickets indistinguishable). This driver makes one utility
call per ticket (one retry), writes ``{ticket, name}`` back, and learns nothing about any group. The prompt states rules, never a sample. Injected fakes; no
live model. Roles only.
"""
import asyncio
import re
from pathlib import Path

from src import orwell_group_identity as g

RULES = (Path(__file__).resolve().parents[2] / "src" / "engine" / "allianceNaming.ts").read_text()
PROMPT = "Rules text.\n" + '{"sharedTraits":["a trait"],"houseCulture":{"spotNicknames":[],"ritualNames":[]}}'
TICKETS = [{"ticket": "nt-a", "prompt": PROMPT}, {"ticket": "nt-b", "prompt": PROMPT}, {"ticket": "nt-c", "prompt": PROMPT}]


def run(coro):
    return asyncio.run(coro)


def test_the_engine_prompt_states_rules_and_has_no_sample_example_or_quoted_list():
    m = re.search(r'export const NAME_RULES =(.*?);\n', RULES, re.S)
    assert m, "NAME_RULES not found"
    text = " ".join(re.findall(r'"((?:[^"\\]|\\.)*)"', m.group(1))).lower()
    assert "rules:" in text
    for banned in ("e.g.", "for example", "such as", "for instance", "like:", "one of the following"):
        assert banned not in text, banned
    assert not re.search(r"['“][^'”]{1,30}['”]\s*,\s*['“]", text)


def test_the_call_carries_the_engine_prompt_verbatim_and_nothing_else():
    assert g.ticket_messages(PROMPT) == [{"role": "user", "content": PROMPT}]


def test_every_ticket_is_answered_the_same_way_one_call_one_write_each():
    calls, writes = [], []

    async def llm(msgs):
        calls.append(msgs)
        return '"Porch Lantern Society"\nextra line'

    async def write(req):
        writes.append(req)
        return {"accepted": True}

    async def read():
        return TICKETS

    out = run(g.run_name_tickets("u", llm_fn=llm, read_fn=read, write_fn=write))
    assert out == {"tickets": 3, "answered": 3}
    assert len(calls) == 3 and [w["ticket"] for w in writes] == ["nt-a", "nt-b", "nt-c"]
    assert all(set(w) == {"ticket", "name"} and w["name"] == "Porch Lantern Society" for w in writes)


def test_a_failed_call_is_retried_once_then_left_unanswered_and_never_raises():
    n = {"calls": 0}

    async def llm(msgs):
        n["calls"] += 1
        raise RuntimeError("boom")

    async def write(req):  # pragma: no cover
        raise AssertionError("nothing to write")

    res = run(g.author_ticket(TICKETS[0], llm, write))
    assert res == {"accepted": False} and n["calls"] == 2


def test_a_write_failure_never_raises():
    async def llm(msgs):
        return "A Name Here"

    async def write(req):
        raise RuntimeError("down")

    assert run(g.author_ticket(TICKETS[0], llm, write)) == {"accepted": False}


def test_nothing_outstanding_makes_no_model_call_and_no_model_leaves_the_floor(monkeypatch):
    resolved = []

    async def fake_resolve(owner):
        resolved.append(owner)
        return None

    monkeypatch.setattr("src.orwell_cast_authoring._resolve_llm_fn", fake_resolve)

    async def empty():
        return []

    async def some():
        return TICKETS

    assert run(g.run_name_tickets("u", read_fn=empty)) == {"tickets": 0} and resolved == []
    assert run(g.run_name_tickets("u", read_fn=some))["reason"] == "no-model"


def test_the_driver_never_learns_who_is_in_a_group():
    src = (Path(__file__).resolve().parents[1] / "src" / "orwell_group_identity.py").read_text()
    block = src[src.index("ORW-566 part c2"):src.index("def kickoff_group_identity")]
    for forbidden in ("members", "groupId", "get_game_state", "public_card", "allianceId"):
        assert forbidden not in block, forbidden


def test_the_engine_wrappers_dispatch_the_two_tools_and_the_kickoff_runs_the_door(monkeypatch):
    from src import orwell_engine as oe
    seen = []

    async def fake_call(tool, args, user=None, **kw):
        seen.append(tool)
        return [{"ticket": "nt-a", "prompt": "p"}] if tool == "allianceNameTickets" else {"accepted": True}

    monkeypatch.setattr(oe, "_call", fake_call)
    assert run(oe.alliance_name_tickets(user="u")) == [{"ticket": "nt-a", "prompt": "p"}]
    assert run(oe.record_alliance_name({"ticket": "nt-a", "name": "x"}, user="u")) == {"accepted": True}
    assert seen == ["allianceNameTickets", "recordAllianceName"]
    assert "await run_name_tickets(owner)" in (Path(__file__).resolve().parents[1] / "src" / "orwell_group_identity.py").read_text()

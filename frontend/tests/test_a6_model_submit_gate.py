"""A-6 (PO ruling 2026-11-03, Ryne) — big irreversible choices bind ONLY on the decision card.

The model's `submitDecision` tool used to accept ANY decision kind; only narrator-prompt wording kept it
from committing a nomination/vote from the player's prose (ADR 0003 + the C20 definition of done say a
hedge in prose cannot bind). Now the tool layer refuses every kind except the low-stakes / in-chat
allow-list, BEFORE any engine call. The card route (POST /api/orwell/decision, the WS relay) is unchanged.
Roles only — no names.
"""
import asyncio
import importlib
import json
import os
import re

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
orwell_engine = importlib.import_module("src.orwell_engine")
tool_impl = importlib.import_module("src.tool_implementations")


def _read(*rel):
    with open(os.path.join(FRONTEND, *rel), encoding="utf-8") as f:
        return f.read()


def test_allow_list_is_exactly_the_low_stakes_kinds_and_card_only_is_the_rest():
    assert orwell_engine.MODEL_SUBMITTABLE_KINDS == {"comp-intent", "comp-round", "deal-offer"}
    assert orwell_engine.CARD_ONLY_KINDS == orwell_engine.DECISION_KINDS - orwell_engine.MODEL_SUBMITTABLE_KINDS
    # Fail closed: every kind the engine can raise is either allow-listed or card-only, with no gap.
    assert orwell_engine.MODEL_SUBMITTABLE_KINDS | orwell_engine.CARD_ONLY_KINDS == orwell_engine.DECISION_KINDS


def test_every_irreversible_kind_is_card_only():
    for kind in ("nominations", "veto-decision", "secret-veto", "eviction-vote", "tie-break",
                 "final-eviction", "goodbye-message", "exit-interview", "finale-statement",
                 "finale-answer", "juror-question", "juror-vote", "replacement",
                 "houseguests-choice", "self-evict"):
        assert kind in orwell_engine.CARD_ONLY_KINDS, kind


def test_card_high_stakes_set_is_a_subset_of_card_only():
    """Parity with the card's own HIGH_STAKES_KINDS (orwellDecision.js): nothing the UI treats as
    weighty may be submittable by the model."""
    js = _read("static", "js", "orwellDecision.js")
    block = re.search(r"const\s+HIGH_STAKES_KINDS\s*=\s*new Set\(\[(.*?)\]\)", js, re.S).group(1)
    kinds = set(re.findall(r'"([a-z-]+)"', re.sub(r"//[^\n]*", "", block)))
    assert kinds, "HIGH_STAKES_KINDS parsed empty"
    assert kinds <= orwell_engine.CARD_ONLY_KINDS, kinds - orwell_engine.CARD_ONLY_KINDS


def _call(kind, **extra):
    return asyncio.run(tool_impl.do_submit_decision(json.dumps({"kind": kind, **extra}), owner="u"))


@pytest.mark.parametrize("kind", sorted(orwell_engine.CARD_ONLY_KINDS))
def test_model_submit_of_a_card_only_kind_is_refused_before_the_engine(kind, monkeypatch):
    calls = []

    async def boom(*a, **k):
        calls.append((a, k))
        raise AssertionError("the engine must not be reached for a card-only kind")

    monkeypatch.setattr(orwell_engine, "submit_decision", boom)
    res = _call(kind, choice=["x", "y"], vote="x", use=True)
    assert res["exit_code"] == 1 and calls == []
    assert "decision card" in res["error"] and "WAIT" in res["error"] and kind in res["error"]


@pytest.mark.parametrize("kind,extra", [("comp-intent", {"intent": "compete"}),
                                        ("comp-round", {"intent": "compete"}),
                                        ("deal-offer", {"vote": "accept"})])
def test_allow_listed_kinds_still_reach_the_engine(kind, extra, monkeypatch):
    seen = []

    async def fake(decision, **k):
        seen.append(decision)
        return {"event": None, "pending": None, "status": {"week": 1}}

    monkeypatch.setattr(orwell_engine, "submit_decision", fake)
    res = _call(kind, **extra)
    assert res["exit_code"] == 0 and seen and seen[0]["kind"] == kind


def test_unknown_kind_still_gets_the_kind_list_error():
    res = _call("coronation")
    assert res["exit_code"] == 1 and "kind must be one of" in res["error"]


def test_tool_description_and_narrator_prompt_state_the_rule():
    schemas = importlib.import_module("src.agent_tools")  # import order: tool_schemas cycles with agent_tools
    ts = importlib.import_module("src.tool_schemas")
    desc = next(t["function"]["description"] for t in ts.FUNCTION_TOOL_SCHEMAS
                if t["function"]["name"] == "submitDecision")
    assert "decision card" in desc and "comp-intent" in desc and "refused" in desc
    prompts = open(os.path.join(os.path.dirname(FRONTEND), "src", "engine", "momentPrompts.ts"), encoding="utf-8").read()
    assert "submitDecision refuses them" in prompts
    assert "bind only on their" in prompts and "decision card" in prompts


# ── PR #1951 review hardening ──────────────────────────────────────────────────────────────────

def _prec_from_ts():
    ts = open(os.path.join(os.path.dirname(FRONTEND), "src", "engine", "momentPrompts.ts"), encoding="utf-8").read()
    start = ts.index('"DECISION PRECEDENCE:')
    end = ts.index('"QUESTION DISCIPLINE')
    lines = re.findall(r'"((?:[^"\\]|\\.)*)"', ts[start:end])
    return " ".join(l.strip() for l in lines)


def _prec_from_py():
    py = _read("routes", "chat_helpers.py")
    start = py.index('"DECISION PRECEDENCE:')
    end = py.index("ambiguous prose.", start) + len("ambiguous prose.")
    return " ".join(l.strip() for l in re.findall(r'"((?:[^"\\]|\\.)*)"', py[start:end + 1]))


def test_decision_precedence_rule_is_identical_in_both_prompt_copies():
    """chat_helpers' pending-decision directive and BASE_GAME_MASTER_PROMPT must carry the SAME rule
    (Finding 13) — a stale copy told the model to submit any pending decision the player picks."""
    norm = lambda t: re.sub(r"\s+", " ", t).strip().rstrip(",")
    assert norm(_prec_from_ts()) == norm(_prec_from_py())
    assert "submit it with submitDecision" not in _read("routes", "chat_helpers.py")


def test_a_refused_submit_is_not_a_resolved_decision_for_the_loop():
    al = importlib.import_module("src.agent_loop")
    refused = {"tool": "submitDecision", "exit_code": 1}
    landed = {"tool": "submitDecision", "exit_code": 0}
    other_failed = {"tool": "advanceGame", "exit_code": 1}
    got = al._landed_tool_events([refused, landed, other_failed])
    assert refused not in got and landed in got and other_failed in got  # only the refusal is dropped
    src = _read("src", "agent_loop.py")
    assert "for ev in _landed_tool_events(tool_events)" in src  # both the progressed set and the beat list use it
    assert src.count("_landed_tool_events(tool_events)") >= 2


def test_schema_parameter_descriptions_do_not_advertise_card_only_kinds_as_submittable():
    importlib.import_module("src.agent_tools")
    ts = importlib.import_module("src.tool_schemas")
    fn = next(t["function"] for t in ts.FUNCTION_TOOL_SCHEMAS if t["function"]["name"] == "submitDecision")
    props = fn["parameters"]["properties"]
    assert "refused" in props["kind"]["description"] and "deal-offer" in props["kind"]["description"]
    assert "confirmed=true" not in props["confirmed"]["description"]
    assert "refused" in props["confirmed"]["description"] or "refuses" in props["confirmed"]["description"]
    for k in ("choice", "use", "save", "replacement", "statement", "appeal"):
        assert "refused here" in props[k]["description"], k
    assert "deal-offer: accept | decline" in props["vote"]["description"]
    assert "standing offer" in props["kind"]["description"].lower()

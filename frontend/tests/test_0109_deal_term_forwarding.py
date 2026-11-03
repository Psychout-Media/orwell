"""0109 / #1993 — the FE forwards the narrator's optional deal `term` to the engine (shape-filtered only; the
ENGINE validates and bounds it), and a call without one is unchanged."""
import asyncio
import json

import importlib

# Prime the agent_tools <-> tool_schemas import cycle first (same as test_0121_deal_kinds).
importlib.import_module("src.agent_tools")
import src.orwell_engine as oe  # noqa: E402
import src.tool_implementations as ti  # noqa: E402
from src.tool_schemas import FUNCTION_TOOL_SCHEMAS  # noqa: E402


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _capture(monkeypatch):
    seen = {}

    async def _fake(with_id, kind, terms, leverage=None, traded_secret=None, user=None, **kw):
        seen.update(kw)
        return {"id": "deal:1"}

    monkeypatch.setattr(oe, "make_deal", _fake)
    return seen


def test_schema_advertises_term():
    deal = next(t for t in FUNCTION_TOOL_SCHEMAS if t["function"]["name"] == "makeDeal")
    props = deal["function"]["parameters"]["properties"]
    assert "term" in props and set(props["term"]["properties"]) == {"weeks", "vague"}
    assert "term" not in deal["function"]["parameters"]["required"]


def test_term_is_forwarded_shape_filtered(monkeypatch):
    seen = _capture(monkeypatch)
    res = _run(ti.do_make_deal(json.dumps(
        {"with": "npc:1", "kind": "final-two", "terms": "t", "term": {"weeks": 2, "junk": 1}}), owner="u"))
    assert res.get("exit_code") == 0
    assert seen["term"] == {"weeks": 2}


def test_bool_weeks_and_non_dict_are_dropped(monkeypatch):
    seen = _capture(monkeypatch)
    _run(ti.do_make_deal(json.dumps({"with": "npc:1", "kind": "safety", "terms": "t", "term": {"weeks": True}}), owner="u"))
    assert "term" not in seen
    _run(ti.do_make_deal(json.dumps({"with": "npc:1", "kind": "safety", "terms": "t", "term": "two weeks"}), owner="u"))
    assert "term" not in seen


def test_vague_forwarded_and_absent_term_leaves_call_unchanged(monkeypatch):
    seen = _capture(monkeypatch)
    _run(ti.do_make_deal(json.dumps({"with": "npc:1", "kind": "safety", "terms": "t", "term": {"vague": True}}), owner="u"))
    assert seen["term"] == {"vague": True}
    seen.clear()
    _run(ti.do_make_deal(json.dumps({"with": "npc:1", "kind": "safety", "terms": "t"}), owner="u"))
    assert seen == {}

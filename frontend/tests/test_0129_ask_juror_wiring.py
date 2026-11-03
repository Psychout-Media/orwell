"""0129 slice 3 — `askJuror` is a prompt-advertised model lever, so it must be agent-callable through the FE tool
layer (the five-place wiring) and forward only {jurorId} (the engine gates, picks and records)."""
import asyncio
import importlib
import json

importlib.import_module("src.agent_tools")  # prime the agent_tools <-> tool_schemas cycle
import src.orwell_engine as oe  # noqa: E402
import src.tool_implementations as ti  # noqa: E402
from src.agent_tools import GAME_TOOL_KEEP, TOOL_TAGS  # noqa: E402
from src.tool_schemas import FUNCTION_TOOL_SCHEMAS, ORWELL_GAME_TOOLS  # noqa: E402


def _run(c):
    return asyncio.new_event_loop().run_until_complete(c)


def test_schema_and_keep_sets():
    names = {t["function"]["name"] for t in FUNCTION_TOOL_SCHEMAS}
    assert "askJuror" in names and "askJuror" in ORWELL_GAME_TOOLS
    assert "askJuror" in GAME_TOOL_KEEP and "askJuror" in str(TOOL_TAGS)


class _Block:
    def __init__(self, tool_type, content):
        self.tool_type = tool_type
        self.content = content


def test_the_dispatcher_routes_askjuror_to_the_engine_wrapper(monkeypatch):
    """Through the REAL `execute_tool_block` dispatcher (not the impl directly): askJuror must not fall through to
    "Unknown tool type", and must reach the engine wrapper with only {jurorId} + the owner."""
    import src.tool_execution as te
    seen = {}

    async def _fake(juror_id, expected_beat_seq=None, idempotency_key=None, user=None):
        seen.update(juror_id=juror_id, user=user)
        return {"told": False, "bearing": "even"}

    monkeypatch.setattr(oe, "ask_juror", _fake)
    desc, res = _run(te.execute_tool_block(_Block("askJuror", json.dumps({"jurorId": "npc:4"})), owner="u"))
    assert desc == "askJuror" and res["exit_code"] == 0
    assert seen == {"juror_id": "npc:4", "user": "u"}
    assert json.loads(res["output"]) == {"told": False, "bearing": "even"}


def test_the_engine_wrapper_request_shape(monkeypatch):
    seen = {}

    async def _call(name, args=None, user=None, timeout=None):
        seen.update(name=name, args=args, user=user)
        return {"ok": True}

    monkeypatch.setattr(oe, "_call", _call)
    _run(oe.ask_juror("npc:4", user="u"))
    assert seen == {"name": "askJuror", "args": {"jurorId": "npc:4"}, "user": "u"}
    _run(oe.ask_juror("npc:4", expected_beat_seq=3, idempotency_key="k", user="u"))
    assert seen["args"] == {"jurorId": "npc:4", "expectedBeatSeq": 3, "idempotencyKey": "k"}


def test_malformed_args_return_an_error_result_not_an_exception():
    for bad in (json.dumps({}), json.dumps({"jurorId": 7}), json.dumps({"jurorId": None}), json.dumps(["npc:4"]), "not json"):
        res = _run(ti.do_ask_juror(bad, owner="u"))
        assert res["exit_code"] == 1 and "error" in res, bad


def test_the_juror_vote_card_renders_the_brief_with_textcontent_only():
    import os
    js = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "js", "orwellDecision.js"), encoding="utf-8").read()
    i = js.index('kind === "juror-vote" && Array.isArray(pending.jurorBrief)')
    block = js[i:i + 1200]
    assert "What the jurors told you" in block
    assert "innerHTML" not in block, "model-adjacent juror text must never go through innerHTML"

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


def test_dispatch_forwards_only_juror_id(monkeypatch):
    seen = {}

    async def _fake(juror_id, expected_beat_seq=None, idempotency_key=None, user=None):
        seen.update(juror_id=juror_id, user=user)
        return {"told": False, "bearing": "even"}

    monkeypatch.setattr(oe, "ask_juror", _fake)
    res = _run(ti.do_ask_juror(json.dumps({"jurorId": "npc:4"}), owner="u"))
    assert res["exit_code"] == 0 and seen == {"juror_id": "npc:4", "user": "u"}
    assert _run(ti.do_ask_juror(json.dumps({}), owner="u"))["exit_code"] == 1

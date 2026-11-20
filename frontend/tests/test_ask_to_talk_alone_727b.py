"""ORW-727b: `askToTalkAlone` (a private word with a houseguest, or asking one to come over) is a MODEL-called lever, so it has the five FE places
(schema + ORWELL_GAME_TOOLS, TOOL_TAGS + GAME_TOOL_KEEP, the engine wrapper, the dispatch, the do_* impl) plus a beat label. These pin that the agent can
really call it end to end and that the args reach the engine unchanged. Roles only. SYNC."""
import asyncio
import importlib
import json
import os

importlib.import_module("src.agent_tools")  # import order: tool_schemas <-> agent_tools is circular when tool_schemas loads first
tool_schemas = importlib.import_module("src.tool_schemas")
agent_tools = importlib.import_module("src.agent_tools")
ti = importlib.import_module("src.tool_implementations")
orwell_engine = importlib.import_module("src.orwell_engine")

FE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _run(coro):
    return asyncio.run(coro)


def test_the_lever_is_agent_callable_in_every_place():
    schema = next(t for t in _all_schemas() if t["function"]["name"] == "askToTalkAlone")
    props = schema["function"]["parameters"]["properties"]
    assert set(props) == {"npcId", "room", "private"} and schema["function"]["parameters"]["required"] == ["npcId"]
    assert props["private"]["type"] == "boolean"
    assert "askToTalkAlone" in tool_schemas.ORWELL_GAME_TOOLS
    assert "askToTalkAlone" in agent_tools.TOOL_TAGS
    assert "askToTalkAlone" in agent_tools.GAME_TOOL_KEEP


def _all_schemas():
    out = []
    for attr in dir(tool_schemas):
        v = getattr(tool_schemas, attr)
        if isinstance(v, list) and v and isinstance(v[0], dict) and v[0].get("type") == "function":
            out.extend(v)
    return out


def test_the_beat_label_exists():
    with open(os.path.join(FE, "static", "js", "orwellToolBeats.js"), encoding="utf-8") as f:
        assert "'askToTalkAlone'" in f.read()


def test_the_dispatch_forwards_the_args_to_the_engine_and_returns_its_result(monkeypatch):
    seen = {}

    async def fake_call(tool, args, user=None):
        seen["tool"], seen["args"] = tool, args
        return {"outcome": "accepted", "room": "storage-room", "roomName": "the storage room", "beatSeq": 4}

    monkeypatch.setattr(orwell_engine, "_call", fake_call)
    out = _run(ti.do_ask_to_talk_alone(json.dumps({"npcId": "npc:1", "room": "storage room", "private": True}), owner="o1"))
    assert out["exit_code"] == 0
    assert seen["tool"] == "askToTalkAlone" and seen["args"] == {"npcId": "npc:1", "room": "storage room", "private": True}
    assert json.loads(out["output"])["outcome"] == "accepted"
    # "come here": private false, no room
    _run(ti.do_ask_to_talk_alone('{"npcId":"npc:1","private":false}', owner="o1"))
    assert seen["args"] == {"npcId": "npc:1", "private": False}


def test_a_missing_houseguest_or_a_bad_flag_is_refused_and_a_null_result_is_not_an_error(monkeypatch):
    assert _run(ti.do_ask_to_talk_alone("{}", owner="o1"))["exit_code"] == 1
    assert _run(ti.do_ask_to_talk_alone('{"npcId":"npc:1","private":"no"}', owner="o1"))["exit_code"] == 1

    async def none_call(tool, args, user=None):
        return None

    monkeypatch.setattr(orwell_engine, "_call", none_call)
    out = _run(ti.do_ask_to_talk_alone('{"npcId":"npc:9"}', owner="o1"))
    assert out["exit_code"] == 0 and "outcome" in out["output"]


def test_the_tool_execution_seam_routes_the_lever():
    with open(os.path.join(FE, "src", "tool_execution.py"), encoding="utf-8") as f:
        src = f.read()
    assert 'tool == "askToTalkAlone"' in src and "do_ask_to_talk_alone(content, owner=owner)" in src

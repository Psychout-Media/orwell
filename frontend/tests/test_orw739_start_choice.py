"""ORW-739 (spec 0208, rule 1): the player chooses at a season's end to start NEW or RETURN as one of their own previous characters.

The model-callable `createCharacter` tool carries `start` and `returnAs`, the relay maps them onto the engine's args, and the tool implementation forwards only values the engine
accepts (the engine validates and refuses the rest, typed). Roles only; the engine is stubbed.
"""

import asyncio
import importlib
import inspect

orwell_engine = importlib.import_module("src.orwell_engine")
# cycle-safe order (tool_schemas imports agent_tools at module level)
tool_impl = importlib.import_module("src.tool_implementations")
importlib.import_module("src.agent_tools")
tool_schemas = importlib.import_module("src.tool_schemas")


def _create_schema():
    return next(t["function"] for t in tool_schemas.FUNCTION_TOOL_SCHEMAS if t["function"]["name"] == "createCharacter")


def test_schema_offers_start_and_returnAs():
    props = _create_schema()["parameters"]["properties"]
    assert props["start"]["enum"] == ["new", "return"]
    assert props["returnAs"]["type"] == "integer"


def test_relay_maps_start_and_returnAs(monkeypatch):
    sent = {}

    async def fake_call(tool, args, user=None):
        sent["args"] = args
        return {"started": True}

    monkeypatch.setattr(orwell_engine, "_call", fake_call)
    asyncio.get_event_loop().run_until_complete(
        orwell_engine.create_character(None, confirm_restart=True, start="return", return_as=2, user="u")
    )
    assert sent["args"]["start"] == "return"
    assert sent["args"]["returnAs"] == 2
    assert sent["args"]["confirmRestart"] is True


def test_relay_sends_nothing_when_the_player_made_no_choice(monkeypatch):
    sent = {}

    async def fake_call(tool, args, user=None):
        sent["args"] = args
        return {"started": True}

    monkeypatch.setattr(orwell_engine, "_call", fake_call)
    asyncio.get_event_loop().run_until_complete(orwell_engine.create_character(None, confirm_restart=True, keep_character=True, user="u"))
    assert "start" not in sent["args"] and "returnAs" not in sent["args"]  # byte-identical for a first-season player


def test_tool_implementation_forwards_only_valid_choices():
    src = inspect.getsource(tool_impl.do_create_character)
    assert 'in ("new", "return")' in src
    assert "return_as=return_as" in src and "start=start_choice" in src

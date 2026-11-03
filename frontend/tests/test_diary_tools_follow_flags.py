"""`playerDossier` / `playerReceipts` are flag-gated engine reads: with the flag OFF the engine returns an empty result, a
DEAD tool. The FE must not send the model a schema for a tool whose engine flag is explicitly OFF. Default / unprobed
flags keep today's tool list (the dealDepth precedent: the SAME list object ⇒ byte-identical). Roles only."""
import importlib

importlib.import_module("src.agent_tools")
ts = importlib.import_module("src.tool_schemas")
oe = importlib.import_module("src.orwell_engine")


def names(schemas):
    return {s["function"]["name"] for s in schemas if isinstance(s, dict)}


def test_unprobed_or_on_flags_keep_the_same_list_object(monkeypatch):
    monkeypatch.setattr(oe, "_ENGINE_FLAGS", {})
    s = ts.ORWELL_GAME_BUILD_SCHEMAS if hasattr(ts, "ORWELL_GAME_BUILD_SCHEMAS") else ts.FUNCTION_TOOL_SCHEMAS
    assert ts.without_flagged_off_diary_tools(s) is s
    monkeypatch.setattr(oe, "_ENGINE_FLAGS", {"playerDossier": True, "boothReceipts": True})
    assert ts.without_flagged_off_diary_tools(s) is s


def test_each_tool_is_dropped_only_when_its_own_flag_is_explicitly_off(monkeypatch):
    s = ts.FUNCTION_TOOL_SCHEMAS
    assert {"playerDossier", "playerReceipts"} <= names(s), "fixture: both schemas exist"
    monkeypatch.setattr(oe, "_ENGINE_FLAGS", {"boothReceipts": False})
    out = names(ts.without_flagged_off_diary_tools(s))
    assert "playerReceipts" not in out and "playerDossier" in out
    monkeypatch.setattr(oe, "_ENGINE_FLAGS", {"playerDossier": False})
    out = names(ts.without_flagged_off_diary_tools(s))
    assert "playerDossier" not in out and "playerReceipts" in out
    monkeypatch.setattr(oe, "_ENGINE_FLAGS", {"playerDossier": False, "boothReceipts": False})
    out = names(ts.without_flagged_off_diary_tools(s))
    assert not ({"playerDossier", "playerReceipts"} & out)
    assert names(s) - out == {"playerDossier", "playerReceipts"}, "nothing else is touched"


def test_the_shared_base_list_is_never_mutated(monkeypatch):
    s = ts.FUNCTION_TOOL_SCHEMAS
    before = len(s)
    monkeypatch.setattr(oe, "_ENGINE_FLAGS", {"playerDossier": False, "boothReceipts": False})
    ts.without_flagged_off_diary_tools(s)
    assert len(s) == before and {"playerDossier", "playerReceipts"} <= names(s)


def test_the_send_site_applies_it_next_to_the_deal_depth_gate():
    import os
    src = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "agent_loop.py"), encoding="utf-8").read()
    import re
    assert re.search(r"all_tool_schemas = with_deal_depth_kinds\(all_tool_schemas\)\s*\n\s*all_tool_schemas = without_flagged_off_diary_tools\(all_tool_schemas\)", src), \
        "the diary gate must sit directly after the deal-depth gate at the send site"

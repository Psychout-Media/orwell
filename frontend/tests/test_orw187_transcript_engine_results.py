"""ORW-187: the persisted transcript must keep the engine's tool results for the read tools whose output used to be blank (#1871) and whose createCharacter result was cut at 2,000
chars. The full (capped) text goes in an admin-only `engine_result`; the player-facing `output` stays blank for silent tools; the player's history payload never carries it. Roles only."""
import importlib
import json

al = importlib.import_module("src.agent_loop")
hr = importlib.import_module("routes.history_routes")


def _res(payload):
    return {"output": json.dumps(payload, indent=2), "exit_code": 0}


def test_silent_read_tools_are_never_blank_in_the_ledger():
    for tool in ("getGameState", "whereabouts", "gameStatus"):
        txt = al._engine_result_for_transcript(tool, _res({"phase": "premiere", "present": ["npc:1"]}))
        assert txt and "premiere" in txt, tool
        assert tool in al._ORWELL_SILENT_TOOLS or tool == "createCharacter"


def test_create_character_result_is_kept_beyond_two_thousand_chars():
    big = {"card": "x" * 5000, "strategyStyle": "strategic"}
    txt = al._engine_result_for_transcript("createCharacter", _res(big))
    assert len(txt) > 5000 and '"strategyStyle": "strategic"' in txt


def test_an_oversized_result_is_capped_with_a_marker_never_blank():
    txt = al._engine_result_for_transcript("getGameState", {"output": "y" * (al._ENGINE_RESULT_CAP + 123)})
    assert txt.startswith("y" * 100) and "[truncated 123 chars]" in txt


def test_the_ledger_set_is_narrow_and_does_not_widen_other_silent_tools():
    assert al._ENGINE_RESULT_LEDGER_TOOLS == {"getGameState", "whereabouts", "gameStatus", "createCharacter"}
    for tool in ("npcVoice", "socialRead", "getVisibleStateFor", "playerDossier", "bash"):
        assert al._engine_result_for_transcript(tool, _res({"knows": ["x"]})) is None


def test_an_empty_or_non_dict_result_yields_none():
    assert al._engine_result_for_transcript("getGameState", {"output": ""}) is None
    assert al._engine_result_for_transcript("getGameState", None) is None


def test_the_error_text_is_kept_when_there_is_no_output():
    assert al._engine_result_for_transcript("whereabouts", {"error": "engine error: boom"}) == "engine error: boom"


def test_the_player_facing_output_stays_blank_for_silent_tools():
    """#1871 is unchanged: the persisted `output` of a silent tool is still the empty string in the wiring."""
    import inspect
    src = inspect.getsource(al)
    assert '_persisted_output = "" if block.tool_type in _ORWELL_SILENT_TOOLS else output_text' in src
    assert 'tool_event["engine_result"] = _engine_result' in src


def test_the_players_history_payload_never_carries_engine_result_and_storage_is_untouched():
    stored = {"role": "assistant", "content": "hi", "metadata": {"tool_events": [
        {"tool": "getGameState", "output": "", "engine_result": "full engine read"},
        {"tool": "bash", "output": "ok"}]}}
    out = hr._without_admin_engine_results([stored])
    evs = out[0]["metadata"]["tool_events"]
    assert all("engine_result" not in e for e in evs) and evs[1]["output"] == "ok"
    assert stored["metadata"]["tool_events"][0]["engine_result"] == "full engine read"  # not mutated
    assert hr._without_admin_engine_results([{"role": "user", "content": "x"}]) == [{"role": "user", "content": "x"}]

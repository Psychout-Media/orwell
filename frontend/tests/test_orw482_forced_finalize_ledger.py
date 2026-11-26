"""ORW-482: the forced casting finalize (the front end calls createCharacter itself when the model never does) used to leave no engine result in the admin transcript, because the ORW-187 ledger lives on model tool
events. The result now goes in its own admin-only metadata key, `admin_engine_results`, which no belt reads (they read `tool_events`) and no non-admin reader sees. Roles only."""
import importlib
import inspect
import json

al = importlib.import_module("src.agent_loop")
models = importlib.import_module("core.models")
hr = importlib.import_module("routes.history_routes")
at = importlib.import_module("routes.admin_transcript_routes")

SECRET = "FORCED-FINALIZE-ENGINE-RESULT-SENTINEL"


def _res(payload):
    return {"output": json.dumps(payload), "exit_code": 0}


def test_the_entry_carries_the_capped_engine_result_and_says_it_was_forced():
    e = al._admin_engine_result_entry(3, "createCharacter", _res({"started": True, "card": SECRET}), forced=True)
    assert e["tool"] == "createCharacter" and e["round"] == 3 and e["forced"] is True and SECRET in e["engine_result"]
    big = al._admin_engine_result_entry(1, "createCharacter", {"output": "z" * (al._ENGINE_RESULT_CAP + 50)}, forced=True)
    assert "[truncated 50 chars]" in big["engine_result"]


def test_a_failed_call_keeps_the_fixed_error_class_and_a_tool_outside_the_ledger_yields_nothing():
    assert al._admin_engine_result_entry(1, "createCharacter", {"error": "boom secret-detail"}, forced=True)["engine_result"] == al._ENGINE_RESULT_ERROR_CLASS
    assert al._admin_engine_result_entry(1, "bash", _res({"x": 1}), forced=True) is None
    assert al._admin_engine_result_entry(1, "createCharacter", {"output": ""}, forced=True) is None


def test_the_forced_finalize_is_wired_into_the_ledger_not_into_tool_events():
    src = inspect.getsource(al)
    assert '_admin_engine_result_entry(round_num, "createCharacter", _cres, forced=True)' in src
    assert 'metrics["admin_engine_results"] = _admin_engine_results' in src
    forced = src.split("FE forced the season start (finalize fallback)", 1)[1][:900]
    assert "tool_events.append" not in forced  # the belts, the sync ledger and the finalize detection keep reading the model's own tool events


def test_no_non_admin_reader_sees_it_even_with_no_tool_events():
    md = {"model": "m", "casting_finalized": True, "admin_engine_results": [{"tool": "createCharacter", "engine_result": SECRET}]}
    pub = models.public_metadata(md)
    assert "admin_engine_results" not in pub and pub["model"] == "m" and pub["casting_finalized"] is True
    assert md["admin_engine_results"][0]["engine_result"] == SECRET  # storage untouched
    both = models.public_metadata({**md, "tool_events": [{"tool": "x", "engine_result": SECRET, "output": "o"}]})
    assert SECRET not in str(both) and both["tool_events"][0]["output"] == "o"
    assert SECRET not in str(models.ChatMessage("assistant", "r", metadata=md).to_dict())
    out = hr._without_admin_engine_results([{"role": "assistant", "content": "r", "metadata": md}])
    assert SECRET not in str(out)


def test_a_client_can_never_write_it():
    assert "admin_engine_results" not in models.client_metadata_update({"admin_engine_results": [{"engine_result": "forged"}], "model": "m"})
    assert models.client_metadata_update({"admin_engine_results": 1, "model": "m"}) == {"model": "m"}


def test_the_admin_markdown_export_lists_it_as_forced_by_the_front_end():
    node = {"role": "assistant", "content": "reply", "metadata": {"admin_engine_results": [{"round": 2, "tool": "createCharacter", "forced": True, "engine_result": SECRET}]}}
    from types import SimpleNamespace
    session_row = SimpleNamespace(id="s", name="n", created_at=None, updated_at=None)
    md = at._render_markdown(session_row, "owner", [node])
    assert SECRET in md and "createCharacter" in md and "forced by the front end" in md and "Engine results (admin only)" in md

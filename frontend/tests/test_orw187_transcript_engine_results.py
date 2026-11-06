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


def test_a_failed_call_keeps_a_fixed_error_class_never_the_raw_error_text():
    out = al._engine_result_for_transcript("whereabouts", {"error": "engine error: boom secret-detail /path/x"})
    assert out == al._ENGINE_RESULT_ERROR_CLASS and "boom" not in out and "secret" not in out


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


# ── one choke point: core.models.public_metadata (a field WHITELIST) ─────────────────────────────────
from core.models import ChatMessage, Session, public_metadata, PUBLIC_TOOL_EVENT_FIELDS  # noqa: E402

SECRET = "FULL-ENGINE-READ-SENTINEL"


def _msg():
    return ChatMessage("assistant", "reply", metadata={"model": "m", "tool_events": [
        {"round": 1, "tool": "getGameState", "command": "x", "output": "", "exit_code": 0, "engine_result": SECRET,
         "future_admin_field": SECRET}]})


def test_public_metadata_is_a_whitelist_and_does_not_mutate_storage():
    m = _msg()
    pub = public_metadata(m.metadata)
    ev = pub["tool_events"][0]
    assert set(ev) <= PUBLIC_TOOL_EVENT_FIELDS and "engine_result" not in ev and "future_admin_field" not in ev
    assert pub["model"] == "m"
    assert m.metadata["tool_events"][0]["engine_result"] == SECRET
    assert public_metadata(None) is None and public_metadata({"a": 1}) == {"a": 1}


def test_chatmessage_to_dict_and_the_provider_context_never_carry_it():
    m = _msg()
    assert SECRET not in str(m.to_dict())
    s = Session(id="s", name="n", endpoint_url="u", model="m", history=[m])
    assert SECRET not in str(s.get_context_messages())


def test_every_route_returning_message_metadata_strips_it():
    """GET /api/history/{id}, GET /history/{sid} (session_routes), POST /api/session/{id}/message round-trip; the SSE metrics replay helper."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    import routes.history_routes as hist
    import routes.session_routes as sess_routes
    session = Session(id="s1", name="n", endpoint_url="u", model="m", history=[_msg()])

    class SM:
        def get_session(self, sid):
            return session

        def add_message(self, sid, msg):
            session.history.append(msg)

        def save_sessions(self):
            pass

    sm = SM()
    hist._verify_session_owner = lambda *a, **k: None
    sess_routes._verify_session_owner = lambda *a, **k: None
    app_h = FastAPI()
    app_h.include_router(hist.setup_history_routes(sm))
    app_s = FastAPI()  # session_routes' own /history/{sid} serializer, mounted alone so it is the one answering
    app_s.include_router(sess_routes.setup_session_routes(sm, {}))
    ch_, cs_ = TestClient(app_h), TestClient(app_s)
    r1 = ch_.get("/api/history/s1")
    assert r1.status_code == 200 and SECRET not in r1.text and "reply" in r1.text
    paths = [r.path for r in app_s.routes if r.path.endswith("/history/{sid}")]
    assert paths, "session_routes exposes /history/{sid}"
    r2 = cs_.get(paths[0].replace("{sid}", "s1"))
    assert r2.status_code == 200 and "reply" in r2.text and SECRET not in r2.text
    c = ch_
    # a client-supplied engine_result is never stored (add_message)
    c.post("/api/session/s1/message", json={"role": "assistant", "content": "x", "metadata": {"tool_events": [{"tool": "t", "engine_result": SECRET}]}})
    assert SECRET not in str(session.history[-1].metadata)
    assert SECRET in str(session.history[0].metadata)  # the stored server-written one is untouched


def test_the_sse_metrics_yield_and_the_import_path_use_public_metadata():
    import inspect
    cr = importlib.import_module("routes.chat_routes")
    src = inspect.getsource(cr)
    assert '"data": public_metadata(last_metrics)' in src
    sr = inspect.getsource(importlib.import_module("routes.session_routes"))
    assert "metadata=public_metadata(m.get(\"metadata\"))" in sr


def test_search_returns_no_metadata_fields():
    ss = importlib.import_module("src.session_search")
    d = ss.SessionSearchResult("i", "s", "n", "user", "c", "snip", None, [], []).to_dict()
    assert "metadata" not in d and "tool_events" not in str(d)

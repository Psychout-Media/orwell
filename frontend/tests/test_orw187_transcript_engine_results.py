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
    assert al._ENGINE_RESULT_LEDGER_TOOLS == {"getGameState", "whereabouts", "gameStatus", "createCharacter"}  # ORW-187's own four
    # ORW-975: plus every NON-silent engine game tool (their output reaches the page as a closed copy; the raw result is admin-only here); the other silent read tools and non-game tools stay out
    wider = al._engine_result_ledger_tools()
    assert al._ENGINE_RESULT_LEDGER_TOOLS <= wider and {"makeDeal", "advanceGame", "submitDecision", "confide", "seasonRetrospective"} <= wider
    assert not ({"npcVoice", "socialRead", "getVisibleStateFor", "playerDossier", "bash"} & wider)
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


def test_every_route_returning_message_metadata_strips_it(monkeypatch):
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
    # Restored after the test (a bare assignment leaked a no-op owner check into every later test in the worker).
    monkeypatch.setattr(hist, "_verify_session_owner", lambda *a, **k: None)
    monkeypatch.setattr(sess_routes, "_verify_session_owner", lambda *a, **k: None)
    # `session_routes.router` is a MODULE-GLOBAL APIRouter: every setup_session_routes() call in the process appends
    # its handlers to it, so an earlier test's /history/{sid} (bound to ITS session manager) answered first and 404'd
    # this one under xdist. A fresh router per test, as test_drawer_hides_nongame_sessions does.
    from fastapi import APIRouter
    monkeypatch.setattr(sess_routes, "router", APIRouter(prefix="/api", tags=["sessions"]))
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


def test_update_last_meta_cannot_touch_the_server_owned_tool_events(monkeypatch):
    """POST /api/session/{id}/update-last-meta merges client metadata into the last assistant message: tool_events / engine_result are server-owned and are never merged.
    Both writes are checked: the in-memory message AND the stored database row (review of #2248: the row was never seeded or read back)."""
    import uuid
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    import routes.history_routes as hist
    from core.models import client_metadata_update
    from core.database import SessionLocal, Session as DbSession, ChatMessage as DbChatMessage
    assert client_metadata_update({"tool_events": [1], "variants": ["a"]}) == {"variants": ["a"]}
    assert client_metadata_update(None) == {} and client_metadata_update("x") == {}
    sid = "orw187-meta-" + uuid.uuid4().hex[:8]
    stored_events = [{"tool": "getGameState", "output": "", "engine_result": SECRET}]
    session = Session(id=sid, name="n", endpoint_url="u", model="m",
                      history=[ChatMessage("assistant", "reply", metadata={"tool_events": stored_events, "model": "m"})])
    with SessionLocal() as db:
        db.add(DbSession(id=sid, name="n", endpoint_url="u", model="m"))
        db.add(DbChatMessage(id=uuid.uuid4().hex, session_id=sid, role="assistant", content="reply", seq=1,
                             meta_data=json.dumps({"tool_events": stored_events, "model": "m"})))
        db.commit()
    try:
        def _row_meta():
            with SessionLocal() as db:
                return json.loads(db.query(DbChatMessage).filter(DbChatMessage.session_id == sid).one().meta_data)

        class SM:
            def get_session(self, sid_):
                return session

            def save_sessions(self):
                pass

        monkeypatch.setattr(hist, "_verify_session_owner", lambda *a, **k: None)  # restored after the test (a bare assignment leaked it into later tests)
        app = FastAPI()
        app.include_router(hist.setup_history_routes(SM()))
        c = TestClient(app)
        r = c.post(f"/api/session/{sid}/update-last-meta", json={"metadata": {"variants": ["v1"], "tool_events": [{"tool": "forged", "engine_result": "FORGED"}]}})
        assert r.status_code == 200
        for md in (session.history[0].metadata, _row_meta()):
            assert md["variants"] == ["v1"]                                   # ordinary keys still merge
            assert md["tool_events"][0]["engine_result"] == SECRET            # the server-written ledger is untouched
            assert "FORGED" not in str(md)
        r = c.post(f"/api/session/{sid}/update-last-meta", json={"metadata": {"tool_events": []}})  # nor can it be deleted
        assert r.status_code == 200
        assert session.history[0].metadata["tool_events"][0]["engine_result"] == SECRET
        assert _row_meta()["tool_events"][0]["engine_result"] == SECRET
    finally:  # review of #2854: the seeded rows never outlive the test in the shared test database
        with SessionLocal() as db:
            db.query(DbChatMessage).filter(DbChatMessage.session_id == sid).delete()
            db.query(DbSession).filter(DbSession.id == sid).delete()
            db.commit()


def test_malformed_client_tool_events_never_pass_the_sanitizer():
    """review of #2248: a non-list `tool_events` (or a non-dict entry) used to pass through unchanged, so the message routes could store a
    forged engine_result for the admin export."""
    forged = {"tool": "getGameState", "engine_result": "FORGED"}
    assert public_metadata({"tool_events": forged, "model": "m"}) == {"tool_events": [], "model": "m"}
    assert public_metadata({"tool_events": "FORGED"})["tool_events"] == []
    assert public_metadata({"tool_events": ["FORGED", forged]})["tool_events"] == [{"tool": "getGameState"}]


def test_markdown_export_includes_the_admin_engine_results():
    """review of #2248: the Markdown export printed only content + tool_calls, never metadata.tool_events[].engine_result."""
    from types import SimpleNamespace
    atr = importlib.import_module("routes.admin_transcript_routes")
    row = SimpleNamespace(id="s", name="n", created_at=None, updated_at=None)
    node = {"role": "assistant", "timestamp": "", "content": "reply",
            "metadata": {"tool_events": [{"round": 2, "tool": "whereabouts", "output": "", "engine_result": SECRET}, {"tool": "bash", "output": "ok"}]}}
    md = atr._render_markdown(row, "owner", [node])
    assert SECRET in md and "`whereabouts` (round 2)" in md
    assert atr._render_markdown(row, "owner", [{"role": "user", "content": "x"}]).count("Engine results") == 0
    # review of #2854: a legacy truthy non-list `tool_events` (a number, a dict, a string) renders without engine results, never a TypeError
    for legacy in (1, {"tool": "t", "engine_result": SECRET}, "text"):
        out = atr._render_markdown(row, "owner", [{"role": "assistant", "content": "reply", "metadata": {"tool_events": legacy}}])
        assert "reply" in out and "Engine results" not in out


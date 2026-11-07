"""ORW-230 / R-VLT-2 — a reloaded GAME row exposes no narrator reasoning.

The ORW-230 split moves a game turn's reasoning out of the reply and into `metadata.thinking`. On reload, classic
renders `metadata.thinking`, and the inline think blocks that agent rounds keep in `metadata.round_texts`, in its
collapsed "Thinking" accordion. Under R-VLT-2 the reasoning is Vault-bearing (the narrator's prompt carries hidden
game state), so for a game or casting session the history the player reloads withholds it:
  * no `metadata.thinking` / `thinking_time`;
  * each round text and the content keep only their narration (a row saved before ORW-230 can hold the
    reasoning as its content);
  * a reasoning-only row is left out like a hidden row, so a reload never paints an empty bubble.
The database rows are unchanged.

`/api/history/{id}` is registered twice (`session_routes`, then `history_routes`) and the app serves the first
match, so both handlers are pinned, alone and in the app's order. Roles only: no names.
"""

import importlib
import types
import uuid

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

from core.models import ChatMessage
from routes import chat_helpers

session_routes = importlib.import_module("routes.session_routes")
history_routes = importlib.import_module("routes.history_routes")
ogs = importlib.import_module("src.orwell_game_session")

_SECRET = "the nominee privately told production they will flip on the HOH"
_PLAN = "plan the beat around the veto"
_NARRATION = "The kitchen goes quiet."
_ROUND_TWO = "Round two lands in the backyard."
_OWNER = "orw230-player"


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(ogs, "GAME_SESSION_PATH", tmp_path / "orwell_game_session.json")
    monkeypatch.delenv("ORWELL_GAME_BUILD", raising=False)  # the product default: the game build is on
    monkeypatch.delenv("BBAI_GAME_BUILD", raising=False)
    # `session_routes.router` is module-global and setup_session_routes() decorates onto it, so each test
    # gets a fresh one (see test_drawer_hides_nongame_sessions.py).
    monkeypatch.setattr(session_routes, "router", APIRouter(prefix="/api", tags=["sessions"]))


@pytest.fixture
def sm():
    from core.session_manager import SessionManager
    from core.models import set_session_manager
    import core.models as core_models
    manager = SessionManager()
    prior = getattr(core_models, "_session_manager", None)
    set_session_manager(manager)
    yield manager
    set_session_manager(prior)


def _client(*routers):
    app = FastAPI()

    @app.middleware("http")
    async def _signed_in(request, call_next):
        request.state.current_user = _OWNER
        return await call_next(request)

    for router in routers:
        app.include_router(router)
    return TestClient(app)


def _routers(which, manager):
    if which == "session_routes":
        return [session_routes.setup_session_routes(manager, {"REQUEST_TIMEOUT": 2})]
    if which == "history_routes":
        return [history_routes.setup_history_routes(manager)]
    # the app's order (app.py): session routes first, then the history routes
    return [session_routes.setup_session_routes(manager, {"REQUEST_TIMEOUT": 2}),
            history_routes.setup_history_routes(manager)]


def _reload(sid, which="app", manager=None):
    """What a reload serves: a FRESH SessionManager (a new process) hydrating the session from the database."""
    from core.session_manager import SessionManager
    res = _client(*_routers(which, manager or SessionManager())).get(f"/api/history/{sid}")
    assert res.status_code == 200
    return res.json()["history"], res.text


def _new_session(sm, name="Season 1"):
    sid = f"orw230-reload-{uuid.uuid4().hex[:10]}"
    sm.create_session(sid, name, "http://x", "the-model", owner=_OWNER)
    return sid, sm.get_session(sid)


def _seed_game_turns(sm, sess, sid):
    """Four game rows, each carrying reasoning a classic reload would have shown."""
    sess.add_message(ChatMessage("user", "what is everyone whispering about?", metadata={}))
    # 1) a game turn the ORW-230 split saved with its reasoning in metadata.thinking
    chat_helpers.save_assistant_response(sess, sm, sid, '<think time="2.1">' + _SECRET + "</think>" + _NARRATION,
                                         {"model": "the-model"}, game=True)
    sess.add_message(ChatMessage("user", "I head outside", metadata={}))
    # 2) an agent turn: its round texts keep each round's inline think (they feed the reload accordion)
    chat_helpers.save_assistant_response(
        sess, sm, sid, "<think>" + _PLAN + "</think>" + _NARRATION + "\n\n<think>" + _SECRET + "</think>" + _ROUND_TWO,
        {"model": "the-model",
         "tool_events": [{"round": 1, "tool": "getGameState", "output": "{}"}],
         "round_texts": ["<think>" + _PLAN + "</think>" + _NARRATION, "<think>" + _SECRET + "</think>" + _ROUND_TWO]},
        game=True)
    sess.add_message(ChatMessage("user", "and the HOH?", metadata={}))
    # 3) a row saved before ORW-230: the cut-off reasoning went in AS the content
    sess.add_message(ChatMessage("assistant", "<think>The player asks. Note: " + _SECRET, metadata={"stopped": True}))
    sess.add_message(ChatMessage("user", "hello?", metadata={}))
    # 4) a game turn cut off before any narration: a reasoning-only row
    chat_helpers.save_stopped_partial(sess, sm, "<think>" + _SECRET, {"stopped": True}, game=True)


def test_a_reloaded_game_session_exposes_no_reasoning_text(sm):
    sid, sess = _new_session(sm)
    _seed_game_turns(sm, sess, sid)
    history, raw = _reload(sid)
    assert _SECRET not in raw
    assert _PLAN not in raw
    assert "<think" not in raw
    for row in history:
        md = row.get("metadata") or {}
        assert "thinking" not in md
        assert "thinking_time" not in md


def test_the_narration_survives_and_each_round_keeps_only_its_own(sm):
    sid, sess = _new_session(sm)
    _seed_game_turns(sm, sess, sid)
    history, _raw = _reload(sid)
    replies = [row for row in history if row["role"] == "assistant"]
    assert [row["content"] for row in replies] == [_NARRATION, _NARRATION + "\n\n" + _ROUND_TWO]
    assert replies[1]["metadata"]["round_texts"] == [_NARRATION, _ROUND_TWO]
    assert replies[1]["metadata"]["tool_events"] == [{"round": 1, "tool": "getGameState", "output": "{}"}]
    # the player's own lines are served verbatim, and every one of them is still there
    assert [row["content"] for row in history if row["role"] == "user"] == [
        "what is everyone whispering about?", "I head outside", "and the HOH?", "hello?"]


def test_the_database_keeps_the_reasoning_the_reload_withholds(sm):
    from core.session_manager import SessionManager
    sid, sess = _new_session(sm)
    _seed_game_turns(sm, sess, sid)
    stored = [m.to_dict() for m in SessionManager().get_session(sid).history]
    assert _SECRET in stored[1]["metadata"]["thinking"]
    assert _SECRET in stored[3]["metadata"]["round_texts"][1]
    assert _SECRET in stored[-1]["metadata"]["thinking"]


@pytest.mark.parametrize("which", ["session_routes", "history_routes", "app"])
def test_both_history_handlers_withhold_it(sm, which):
    sid, sess = _new_session(sm)
    _seed_game_turns(sm, sess, sid)
    history, raw = _reload(sid, which)
    assert _SECRET not in raw and _PLAN not in raw
    assert [row["content"] for row in history if row["role"] == "assistant"] == [
        _NARRATION, _NARRATION + "\n\n" + _ROUND_TWO]


def test_the_history_routes_database_fallback_withholds_it(sm):
    """history_routes reads the database when the in-memory history is empty; that path withholds it too."""
    sid, sess = _new_session(sm)
    _seed_game_turns(sm, sess, sid)
    empty = types.SimpleNamespace(id=sid, owner=_OWNER, history=[], model="the-model", endpoint_url="http://x",
                                  name="Season 1")
    manager = types.SimpleNamespace(get_session=lambda _sid: empty, sessions={})
    history, raw = _reload(sid, "history_routes", manager)
    assert _SECRET not in raw and _PLAN not in raw
    assert [row["content"] for row in history if row["role"] == "assistant"] == [
        _NARRATION, _NARRATION + "\n\n" + _ROUND_TWO]


def test_a_casting_session_in_the_workspace_build_withholds_it(sm, monkeypatch):
    """With the game build off, a session that holds casting rows is still a framed session."""
    monkeypatch.setenv("ORWELL_GAME_BUILD", "0")
    sid, sess = _new_session(sm, name="Casting interview")
    sess.add_message(ChatMessage("user", "I'm a teacher from Ohio", metadata={"phase": "casting"}))
    chat_helpers.save_assistant_response(sess, sm, sid, "<think>" + _SECRET + "</think>Tell me more.",
                                         {"model": "the-model"}, phase="casting", game=True)
    history, raw = _reload(sid)
    assert _SECRET not in raw
    assert history[-1]["content"] == "Tell me more."


def test_an_ordinary_workspace_chat_still_serves_its_thinking(sm, monkeypatch):
    """Guard: outside the game (workspace build, no game or casting rows) the reload accordion is unchanged."""
    monkeypatch.setenv("ORWELL_GAME_BUILD", "0")
    sid, sess = _new_session(sm, name="Chat")
    sess.add_message(ChatMessage("user", "hi", metadata={}))
    chat_helpers.save_assistant_response(sess, sm, sid, "<think>plan a greeting</think>Hello!", {"model": "the-model"})
    history, _raw = _reload(sid)
    assert history[-1]["content"] == "Hello!"
    assert history[-1]["metadata"]["thinking"] == "plan a greeting"

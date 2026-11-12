"""ORW-44 S4b2: the game build is WebSocket-only. The SSE mirror routes (events, resume) refuse there with a typed error (426 `ws-only`); the non-game build keeps them.
The chat_stream refusal and its client notice land in S4b3, after the HTTP-driving tests move to a WS driver."""
import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routes import chat_routes, ws_routes

_OWNER = "orw44-owner"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(ws_routes, "_turn_stream_factory", ws_routes._turn_stream_factory)
    app = FastAPI()

    @app.middleware("http")
    async def _signed_in(request, call_next):
        request.state.current_user = _OWNER
        return await call_next(request)

    app.include_router(chat_routes.setup_chat_routes(None, None, None, None, None, None))
    return TestClient(app)


@pytest.fixture
def sid():
    from core.session_manager import SessionManager
    session_id = f"orw44-{uuid.uuid4().hex[:10]}"
    SessionManager().create_session(session_id, "Season 1", "http://x", "the-model", owner=_OWNER)
    return session_id


def test_game_build_refuses_events_and_resume_with_a_typed_error(monkeypatch, client, sid):
    monkeypatch.setenv("ORWELL_GAME_BUILD", "1")
    for path in (f"/api/chat/events/{sid}", f"/api/chat/resume/{sid}"):
        r = client.get(path)
        assert r.status_code == 426, (path, r.status_code)
        assert r.json()["error"] == "ws-only" and "blocks the live connection" in r.json()["reason"]


def test_non_game_build_keeps_the_sse_routes(monkeypatch, client, sid):
    monkeypatch.setenv("ORWELL_GAME_BUILD", "0")
    r = client.get(f"/api/chat/resume/{sid}")
    assert r.status_code == 404 and r.json().get("detail") == "No active run for this session"   # the normal "no run to resume", not the ws-only refusal

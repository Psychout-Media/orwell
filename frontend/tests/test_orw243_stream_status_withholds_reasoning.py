"""ORW-243 — `/api/chat/stream_status` never sends a game turn's reasoning to the player's browser.

The status probe returned the active-stream record as it was, `partial` included: the raw text streamed so far,
with any open think. The record accumulates the reply deltas, and a model's inline `<think>` travels in them.
Under R-VLT-2 the narrator's reasoning is Vault-bearing (its prompt carries hidden game state). So the stream
now records whether the turn was framed (game, casting or the feeds-down framing), and for a framed turn the
probe drops `partial`. It fails closed: only a record registered as unframed returns it. No client reads
`partial` (sessions.js reads `status`, `mode` and `is_research`), and an unframed turn is answered as before,
minus the internal flag. Roles only: no names.
"""

import importlib
import inspect
import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

chat_routes = importlib.import_module("routes.chat_routes")
ws_routes = importlib.import_module("routes.ws_routes")

_SECRET = "the nominee privately told production they will flip on the HOH"
_OWNER = "orw243-player"


@pytest.fixture
def client(monkeypatch):
    # setup_chat_routes registers the WS `turn` producer module-globally: put the prior one back afterwards.
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
    session_id = f"orw243-{uuid.uuid4().hex[:10]}"
    SessionManager().create_session(session_id, "Season 1", "http://x", "the-model", owner=_OWNER)
    yield session_id
    chat_routes._active_streams.pop(session_id, None)


def _streaming(sid, partial, **flags):
    """An active-stream record shaped as `stream_with_save` registers it, `partial` grown by the reply deltas."""
    chat_routes._active_streams[sid] = {
        "status": "streaming", "partial": partial, "query": "what is everyone whispering about?",
        "is_research": False, "mode": "agent", **flags,
    }


def _status(client, sid):
    res = client.get(f"/api/chat/stream_status/{sid}")
    assert res.status_code == 200
    return res


def test_a_game_turn_with_an_open_think_returns_no_reasoning_text(client, sid):
    _streaming(sid, "The kitchen goes quiet.\n\n<think>The player asks. Note: " + _SECRET, framed=True)
    res = _status(client, sid)
    assert _SECRET not in res.text
    assert "<think" not in res.text
    body = res.json()
    assert "partial" not in body
    # the reconnect signal the client reads is intact, and the internal flag is not echoed
    assert body["status"] == "streaming"
    assert body["mode"] == "agent"
    assert body["is_research"] is False
    assert "framed" not in body


def test_a_record_not_registered_as_unframed_withholds_the_partial(client, sid):
    """Fail closed: a record without the framing flag is treated as framed."""
    _streaming(sid, "<think>" + _SECRET)
    res = _status(client, sid)
    assert _SECRET not in res.text
    assert "partial" not in res.json()


def test_an_unframed_turn_still_returns_its_partial(client, sid):
    _streaming(sid, "Half a sentence", framed=False)
    body = _status(client, sid).json()
    assert body["partial"] == "Half a sentence"
    assert body["status"] == "streaming"
    assert "framed" not in body


def test_the_stream_records_the_turns_framing_when_it_registers():
    src = inspect.getsource(chat_routes)
    line = src[src.index("_active_streams[session] = {"):]
    line = line[:line.index("\n")]
    assert '"framed": bool(ctx.framed)' in line

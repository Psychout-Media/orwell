"""ORW-408 second round, finding 1: the quiet rewrite's keepalive must REACH the client on both transports. The agent loop yielded an SSE comment line (`: keepalive`); the chat route's consumer
chain only relays `data: ` / `event: ` chunks, so it was dropped there and the player (SSE and WebSocket alike) saw nothing for up to 28 s. The loop now yields a `data:` event of a type the client
ignores; these tests run the REAL chat route chain and the REAL ws relay over a stubbed agent loop. Roles only; no model."""
import importlib
import json
import types
import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from tests.support import ws_harness as H

chat_routes = importlib.import_module("routes.chat_routes")
chat_helpers = importlib.import_module("routes.chat_helpers")
ws_routes = importlib.import_module("routes.ws_routes")
_OWNER = "orw408-player"


def _loop_with_keepalive(al):
    async def fake_loop(*a, **k):
        yield 'data: {"delta": "The kitchen is quiet. "}\n\n'
        yield al._PD_KEEPALIVE
        yield al._PD_KEEPALIVE
        yield 'data: {"delta": "Someone laughs."}\n\n'
        yield "data: [DONE]\n\n"
    return fake_loop


def _ctx():
    return chat_helpers.ChatContext(
        preface=[], rag_sources=[], web_sources=[], used_memories=[], messages=[{"role": "user", "content": "hi"}], context_length=8000, was_compacted=False, user=_OWNER, uprefs={},
        preset=chat_helpers.PresetInfo(temperature=0.7, max_tokens=512, system_prompt=None, character_name=None),
        preprocessed=chat_helpers.PreprocessedMessage(enhanced_message="hi", user_content="hi", text_for_context="hi", youtube_transcripts=[], attachment_meta=[]))


@pytest.fixture
def route_client(monkeypatch):
    from src import agent_loop as al
    from core.session_manager import SessionManager
    monkeypatch.setattr(ws_routes, "_turn_stream_factory", ws_routes._turn_stream_factory)
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setattr(chat_routes, "_game_build_ws_only", lambda: False)
    monkeypatch.setattr(chat_routes, "_clear_orphaned_session_endpoint", lambda *a, **k: False)
    monkeypatch.setattr(chat_routes, "stream_agent_loop", _loop_with_keepalive(al))

    async def fake_ctx(*a, **k):
        return _ctx()
    monkeypatch.setattr(chat_routes, "build_chat_context", fake_ctx)
    app = FastAPI()

    @app.middleware("http")
    async def _signed_in(request, call_next):
        request.state.current_user = _OWNER
        return await call_next(request)

    sm = SessionManager()
    app.include_router(chat_routes.setup_chat_routes(sm, None, None, None, None, None))
    sid = f"orw408-{uuid.uuid4().hex[:8]}"
    sm.create_session(sid, "Chat", "http://x", "the-model", owner=_OWNER)
    return TestClient(app), sid


def test_the_chat_route_relays_the_keepalive_to_the_sse_client(route_client):
    client, sid = route_client
    res = client.post("/api/chat_stream", data={"message": "hi", "session": sid, "mode": "agent"})
    assert res.status_code == 200
    events = [json.loads(b[6:]) for b in res.text.split("\n\n") if b.startswith("data: ") and not b.startswith("data: [DONE]")]
    beats = [e for e in events if e.get("type") == "keepalive"]
    assert len(beats) == 2, f"both keepalives must reach the client, got: {res.text!r}"
    # the beats sit between the two deltas, in order, and never appear as reply text
    kinds = [("keepalive" if e.get("type") == "keepalive" else "delta") for e in events if e.get("type") in (None, "keepalive") ]
    assert kinds.index("keepalive") > kinds.index("delta")
    assert "keepalive" not in "".join(e.get("delta", "") for e in events)


def test_the_ws_relay_carries_the_keepalive_as_a_chat_event(run, monkeypatch):
    # the SAME real producer (`_prepare_chat_stream`) feeds the WS `turn` relay; its SSE output fans over the socket's chat channel
    from src import agent_loop as al
    assert ws_routes._sse_to_payload(al._PD_KEEPALIVE) == {"type": "keepalive"}

    async def _prepare(request):
        async def _safe_stream():
            async for c in _loop_with_keepalive(al)():
                yield c
        return chat_routes._PreparedChatTurn(_safe_stream, (await request.form())["session"], object(), False)

    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setattr(ws_routes, "_is_live", lambda sid: True)
    monkeypatch.setattr(chat_routes, "_resolve_fastapi_app", lambda: types.SimpleNamespace(state=types.SimpleNamespace(auth_manager=None)))

    async def _state(user):
        return {"started": True, "beatSeq": 5}
    monkeypatch.setattr(ws_routes, "_engine_state", _state)
    H.reset_runs()
    ws_routes.set_turn_stream_factory(chat_routes.make_ws_turn_stream_factory(_prepare))

    async def main():
        canon = H.seed_live_game(None, "live-canon")
        ws = H.new_ws(); t = H.spawn(ws)
        await H.hello(ws, canon)
        ws.client_send({"t": "turn", "ch": "chat", "cid": "c_turn", "d": {"message": "hi", "clientMsgId": "tmp_1", "mode": "agent", "expectedBeatSeq": 5}})
        await ws.recv_where(lambda f: f.get("t") == "ack" and f.get("cid") == "c_turn")
        ws.client_send({"t": "subscribe", "ch": "chat", "cid": "c_sub", "d": {"fromSeq": 0}})
        await ws.recv_where(lambda f: f.get("t") == "ack" and f.get("cid") == "c_sub" and f.get("ch") == "chat")
        frames = await ws.collect_until(lambda f: f.get("t") == "event" and f.get("ch") == "chat" and f.get("d", {}).get("done"), timeout=2.0)
        await H.stop(ws, t)
        await H.aclose_runs()
        return [f["d"] for f in frames if f.get("t") == "event" and f.get("ch") == "chat"]
    try:
        payloads = run(main())
    finally:
        H.reset_runs()
        ws_routes.set_turn_stream_factory(None)
    assert [p for p in payloads if p.get("type") == "keepalive"] == [{"type": "keepalive"}, {"type": "keepalive"}]
    assert payloads[-1] == {"done": True}

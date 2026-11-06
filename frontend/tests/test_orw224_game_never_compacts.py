"""ORW-224: maybe_compact ends in replace_messages, which DELETES and re-inserts every stored chat row. A game or
casting session must never be rewritten that way (non-degradation, mandate #4): the trimmer shortens the prompt only.
Roles only; no names."""
import asyncio
import os
import uuid

import pytest
from sqlalchemy import text

import src.context_compactor as cc
from core.models import ChatMessage, set_session_manager
import core.models as core_models


@pytest.fixture
def mgr():
    from core.session_manager import SessionManager
    manager = SessionManager()
    prior = getattr(core_models, "_session_manager", None)
    set_session_manager(manager)
    yield manager
    set_session_manager(prior)


def _patch(monkeypatch, calls):
    async def tiny_window(url, model):
        return 100  # far over the 85% trigger

    async def fake_llm(*a, **k):
        calls["n"] += 1
        return "SUMMARY"

    monkeypatch.setattr(cc, "get_context_length_async", tiny_window)
    monkeypatch.setattr(cc, "llm_call_async", fake_llm)
    monkeypatch.setattr(cc, "resolve_endpoint", lambda *a, **k: (None, None, None))
    cc._compaction_in_flight.clear()
    cc._background_tasks.clear()


def _session(mgr, sid, phase):
    mgr.create_session(sid, "n", "http://x", "m", owner="u")
    sess = mgr.get_session(sid)
    for i in range(8):
        sess.add_message(ChatMessage(role="user", content=f"u{i} " + "x" * 300, metadata={"phase": phase} if phase else {},
                                     client_msg_id=str(uuid.uuid4())))
        sess.add_message(ChatMessage(role="assistant", content=f"a{i} " + "y" * 300, metadata={}))
    return sess


def _rows(sid):
    from core.database import engine
    with engine.begin() as c:
        return c.execute(text("SELECT id, seq, client_msg_id FROM chat_messages WHERE session_id=:s ORDER BY seq"), {"s": sid}).fetchall()


def _drive(sess, **kw):
    async def go():
        out = await cc.maybe_compact(sess, "u", "m", sess.get_context_messages(), **kw)
        if cc._background_tasks:
            await asyncio.gather(*list(cc._background_tasks))
        return out
    return asyncio.run(go())


def test_game_session_over_trigger_never_deletes_or_reinserts_rows(mgr, monkeypatch):
    calls = {"n": 0}
    _patch(monkeypatch, calls)
    sess = _session(mgr, "orw224-game", "game")
    before = _rows("orw224-game")
    _msgs, _ctx, was = _drive(sess, persist_history=False)
    assert was is False and calls["n"] == 0, "no summary is even requested"
    after = _rows("orw224-game")
    assert after == before, "same row ids, same seq, same client_msg_id: nothing deleted or re-inserted"
    assert not any((m.metadata or {}).get("compacted") for m in sess.history)


def test_non_game_compaction_is_unchanged(mgr, monkeypatch):
    calls = {"n": 0}
    _patch(monkeypatch, calls)
    sess = _session(mgr, "orw224-plain", None)
    before_ids = {r.id for r in _rows("orw224-plain")}
    _drive(sess)  # default persist_history=True
    assert calls["n"] == 1
    after_ids = {r.id for r in _rows("orw224-plain")}
    assert after_ids.isdisjoint(before_ids), "non-game compaction still rewrites (documented, ORW-224 is game-only)"
    assert any((m.metadata or {}).get("compacted") for m in sess.history)


def test_unframed_session_whose_rows_carry_game_or_casting_phase_is_refused_too(mgr, monkeypatch):
    """Edge case: even when the caller says persist_history=True (not framed), stored game/casting rows win."""
    for tag, phase in (("g", "game"), ("c", "casting")):
        calls = {"n": 0}
        _patch(monkeypatch, calls)
        sess = _session(mgr, f"orw224-edge-{tag}", phase)
        before = _rows(f"orw224-edge-{tag}")
        _drive(sess)  # persist_history default True
        assert calls["n"] == 0 and _rows(f"orw224-edge-{tag}") == before


# ── the two manual routes (they DELETE rows too, and the player can trigger them) ──

def _client(mgr, *, which):
    from fastapi import FastAPI, Request
    from fastapi.testclient import TestClient

    app = FastAPI()

    @app.middleware("http")
    async def stamp(request: Request, call_next):
        request.state.current_user = "u"
        request.state.api_token = True
        request.state.api_token_owner = "u"
        return await call_next(request)

    if which == "history":
        from routes import history_routes
        app.include_router(history_routes.setup_history_routes(mgr))
        return TestClient(app, raise_server_exceptions=False), "/api/session/{}/compact"
    from routes import session_routes
    app.include_router(session_routes.setup_session_routes(mgr, {}))
    return TestClient(app, raise_server_exceptions=False), "/api/session/{}/compact"


@pytest.mark.parametrize("which", ["history", "session"])
@pytest.mark.parametrize("phase", ["game", "casting"])
def test_manual_compact_routes_refuse_game_sessions_and_delete_nothing(mgr, monkeypatch, which, phase):
    from src import llm_core
    calls = {"n": 0}

    async def fake_llm(*a, **k):
        calls["n"] += 1
        return "SUMMARY"

    monkeypatch.setattr(llm_core, "llm_call_async", fake_llm)
    sid = f"orw224-route-{which}-{phase}"
    _session(mgr, sid, phase)
    before = _rows(sid)
    client, path = _client(mgr, which=which)
    resp = client.post(path.format(sid))
    assert resp.status_code == 409, resp.text
    assert "Compaction is off for game sessions" in resp.text
    assert calls["n"] == 0, "no summary requested"
    assert _rows(sid) == before, "no row deleted, inserted or re-id'd"


def test_canonical_bound_game_session_is_refused_even_without_stamped_rows(mgr, monkeypatch):
    import src.orwell_game_session as ogs
    sid = "orw224-bound"
    _session(mgr, sid, None)
    monkeypatch.setattr(ogs, "get_game_session", lambda user: sid)
    client, path = _client(mgr, which="history")
    assert client.post(path.format(sid)).status_code == 409


def test_manual_compact_route_still_works_for_a_plain_chat(mgr, monkeypatch):
    from src import llm_core
    async def fake_llm(*a, **k):
        return "SUMMARY"
    monkeypatch.setattr(llm_core, "llm_call_async", fake_llm)
    sid = "orw224-route-plain"
    _session(mgr, sid, None)
    client, path = _client(mgr, which="session")
    assert client.post(path.format(sid)).status_code != 409


def test_ui_hides_compact_entry_points_in_the_game_build():
    here = os.path.dirname(__file__)
    slash = open(os.path.join(here, "..", "static", "js", "slashCommands.js"), encoding="utf-8").read()
    body = slash.split("async function _cmdCompact", 1)[1].split("// ── TTS", 1)[0]
    assert "isGameBuild()" in body and body.index("isGameBuild()") < body.index("fetch("), "the command refuses before any request"
    ring = open(os.path.join(here, "..", "static", "js", "chatRenderer.js"), encoding="utf-8").read()
    assert "ctxPct >= 70 && !isGameBuild()" in ring, "the Compact context button is not rendered in the game build"

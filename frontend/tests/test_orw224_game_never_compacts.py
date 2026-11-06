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


def test_build_chat_context_passes_the_game_guard():
    src = open(os.path.join(os.path.dirname(__file__), "..", "routes", "chat_helpers.py"), encoding="utf-8").read()
    assert "persist_history=not (game_active or framed)" in src

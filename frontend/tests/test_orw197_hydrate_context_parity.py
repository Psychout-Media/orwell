"""ORW-197 (narrator half): after a front-end restart the narrator's context must equal the live context.

Live 2026-11-06 (prod): post-restart narrator requests held 13 user turns and ZERO assistant turns. Root cause: the
`Session.messages` relationship had no `order_by`; SQLite served the rows through the UNIQUE
(session_id, client_msg_id) index, so every assistant row (client_msg_id NULL) came first and the user rows
followed in client-id order. `get_context_messages(exclude_pre_game=True)` cuts everything before the first
`game`-stamped row by INDEX, and game-phase assistant rows carry no phase stamp, so every assistant turn
landed before the boundary and was dropped. Roles only; no names."""
import uuid

import pytest

from core.models import ChatMessage, set_session_manager
import core.models as core_models

CTX_KW = dict(exclude_phases={"casting"}, exclude_pre_game=True)  # exactly what routes/chat_helpers.py passes on a live game turn


@pytest.fixture
def client_id_index_only():
    """Reproduce the prod row order. SQLite chooses the index for `WHERE session_id=?` itself; with the
    UNIQUE (session_id, client_msg_id) index chosen, rows come back assistants-first (NULL ids sort first)
    and then users in random client-id order. Which index wins depends on the DB's stats, so make the
    bad plan the only plan, then restore the other indexes."""
    from sqlalchemy import text
    from core.database import engine
    with engine.begin() as c:
        rows = c.execute(text("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='chat_messages' "
                              "AND sql IS NOT NULL AND name != 'ix_messages_session_client_msg_id'")).fetchall()
        for name, _ in rows:
            c.execute(text(f'DROP INDEX IF EXISTS "{name}"'))
    yield
    with engine.begin() as c:
        for _, sql in rows:
            c.execute(text(sql))


@pytest.fixture
def mgr():
    from core.session_manager import SessionManager
    manager = SessionManager()
    prior = getattr(core_models, "_session_manager", None)
    set_session_manager(manager)
    yield manager
    set_session_manager(prior)


def _build_prod_shaped_session(mgr, sid, game_turns=14):
    """user rows carry client_msg_id (random uuids, so they do NOT sort in send order); casting rows are stamped
    `casting`; game user rows `game`; game ASSISTANT rows carry game metadata but NO phase stamp."""
    mgr.create_session(sid, "n", "http://x", "m", owner="u")
    sess = mgr.get_session(sid)
    for i in range(3):  # casting interview
        sess.add_message(ChatMessage(role="user", content=f"casting user {i}", metadata={"phase": "casting"},
                                     client_msg_id=str(uuid.uuid4())))
        sess.add_message(ChatMessage(role="assistant", content=f"casting reply {i}", metadata={"phase": "casting", "model": "m"}))
    for i in range(game_turns):
        sess.add_message(ChatMessage(role="user", content=f"game user {i}", metadata={"phase": "game"},
                                     client_msg_id=str(uuid.uuid4())))
        sess.add_message(ChatMessage(role="assistant", content=f"game reply {i}", metadata={"model": "m", "beatSeq": i}))
    return sess


def _fresh(mgr_cls_sid):
    from core.session_manager import SessionManager
    fresh = SessionManager()  # a restart: empty cache, hydrate from the DB
    set_session_manager(fresh)
    return fresh.get_session(mgr_cls_sid)


def test_hydrated_history_is_in_seq_order(mgr, client_id_index_only):
    sid = "orw197-order"
    live = _build_prod_shaped_session(mgr, sid)
    hydrated = _fresh(sid)
    assert [m.metadata["_seq"] for m in hydrated.history] == list(range(len(live.history)))
    assert [(m.role, m.content) for m in hydrated.history] == [(m.role, m.content) for m in live.history]


def test_narrator_context_after_restart_equals_live_context_with_both_roles_in_order(mgr, client_id_index_only):
    sid = "orw197-parity"
    live = _build_prod_shaped_session(mgr, sid)
    live_ctx = live.get_context_messages(**CTX_KW)
    hydrated = _fresh(sid)
    ctx = hydrated.get_context_messages(**CTX_KW)

    assert [(m["role"], m["content"]) for m in ctx] == [(m["role"], m["content"]) for m in live_ctx]
    roles = [m["role"] for m in ctx]
    assert roles.count("assistant") == 14 and roles.count("user") == 14, "the narrator must see its own replies"
    assert roles == ["user", "assistant"] * 14, "strictly alternating, in order"
    assert not any("casting" in m["content"] for m in ctx), "the casting wall still holds after hydrate"


def test_regression_exact_failure_no_assistant_turns_after_restart(mgr, client_id_index_only):
    """The prod symptom: N user turns, zero assistant turns in the post-restart context."""
    sid = "orw197-regress"
    _build_prod_shaped_session(mgr, sid, game_turns=13)
    ctx = _fresh(sid).get_context_messages(**CTX_KW)
    assert sum(1 for m in ctx if m["role"] == "user") == 13
    assert sum(1 for m in ctx if m["role"] == "assistant") == 13


def test_relationship_declares_order_by_seq():
    from core.database import Session as DbSession
    ob = DbSession.messages.property.order_by
    assert ob, "Session.messages must declare an explicit order_by"
    assert "seq" in str(ob[0])

"""ORW-199 + ORW-200: session auth headers are resolved from the endpoint record at call time,
and provider credentials are no longer persisted on session rows when an endpoint supplies them.

Private in-memory DB: only the `model_endpoints` and `sessions` tables are created, and the
SessionLocal handles in the modules under test are pointed at it.
"""
import os
import re
import types

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import core.database as d
from src import endpoint_resolver as er

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OR_BASE = "https://openrouter.ai/api/v1"
DS_BASE = "https://api.deepseek.com/v1"


@pytest.fixture()
def db(monkeypatch):
    eng = create_engine("sqlite://", connect_args={"check_same_thread": False},
                        poolclass=__import__("sqlalchemy.pool", fromlist=["StaticPool"]).StaticPool)
    d.Base.metadata.create_all(eng, tables=[d.ModelEndpoint.__table__, d.Session.__table__])
    S = sessionmaker(bind=eng)
    monkeypatch.setattr(er, "SessionLocal", S)
    import routes.session_routes as sr
    import routes.chat_helpers as ch
    monkeypatch.setattr(sr, "SessionLocal", S)
    monkeypatch.setattr(ch, "SessionLocal", S)
    return S


def _ep(S, ep_id, base, key, owner="u1", enabled=True):
    with S() as s:
        s.add(d.ModelEndpoint(id=ep_id, name=ep_id, base_url=base, api_key=key,
                              is_enabled=enabled, owner=owner))
        s.commit()


def _row(S, sid, url, headers, owner="u1"):
    with S() as s:
        s.add(d.Session(id=sid, name=sid, endpoint_url=url, model="m", headers=headers, owner=owner))
        s.commit()


def _sess(url, headers, owner="u1"):
    return types.SimpleNamespace(id="s", endpoint_url=url, model="m", headers=headers, owner=owner)


def _stored(S, sid):
    with S() as s:
        return s.get(d.Session, sid).headers


# ---- resolve_session_headers -------------------------------------------------------------

def test_key_rotation_reaches_a_live_session(db):
    _ep(db, "or", OR_BASE, "sk-old")
    sess = _sess(OR_BASE + "/chat/completions", {"Authorization": "Bearer sk-old"})
    assert er.resolve_session_headers(sess)["Authorization"] == "Bearer sk-old"
    with db() as s:
        s.get(d.ModelEndpoint, "or").api_key = "sk-new"
        s.commit()
    # Same live session object, stored headers untouched, new key is what gets sent.
    assert er.resolve_session_headers(sess)["Authorization"] == "Bearer sk-new"
    assert sess.headers == {"Authorization": "Bearer sk-old"}


def test_provider_switch_uses_the_new_providers_key(db):
    """Live 401: URL/model moved to DeepSeek but the row still carried the OpenRouter key."""
    _ep(db, "or", OR_BASE, "sk-or")
    _ep(db, "ds", DS_BASE, "sk-ds")
    sess = _sess(DS_BASE + "/chat/completions",
                 {"Authorization": "Bearer sk-or", "X-Custom": "keep"})
    out = er.resolve_session_headers(sess)
    assert out["Authorization"] == "Bearer sk-ds"
    assert out["X-Custom"] == "keep"
    assert "sk-or" not in str(out)


def test_anthropic_style_key_replaces_stale_bearer(db):
    _ep(db, "an", "https://api.anthropic.com", "sk-ant")
    out = er.resolve_session_headers(
        _sess("https://api.anthropic.com/v1/messages", {"Authorization": "Bearer sk-or"}))
    assert out.get("x-api-key") == "sk-ant"
    assert "Authorization" not in out


def test_no_matching_endpoint_uses_stored_headers(db):
    _ep(db, "or", OR_BASE, "sk-or")
    stored = {"Authorization": "Bearer custom-key"}
    sess = _sess("https://my-llm.local/v1/chat/completions", stored)
    assert er.resolve_session_headers(sess) == stored


def test_disabled_or_unkeyed_endpoint_does_not_override(db):
    _ep(db, "off", DS_BASE, "sk-ds", enabled=False)
    stored = {"Authorization": "Bearer mine"}
    assert er.resolve_session_headers(_sess(DS_BASE, stored)) == stored
    _ep(db, "nokey", "https://local.test/v1", None)
    assert er.resolve_session_headers(_sess("https://local.test/v1/chat/completions", stored)) == stored


def test_owner_scoping_includes_shared_but_not_other_users(db):
    _ep(db, "shared", DS_BASE, "sk-shared", owner=None)
    _ep(db, "theirs", OR_BASE, "sk-theirs", owner="u2")
    assert er.resolve_session_headers(_sess(DS_BASE, {}))["Authorization"] == "Bearer sk-shared"
    stored = {"Authorization": "Bearer x"}
    assert er.resolve_session_headers(_sess(OR_BASE, stored)) == stored  # u2's row is invisible


def test_resolver_error_falls_back_to_stored_never_empty(db, monkeypatch):
    def boom():
        raise RuntimeError("db down")
    monkeypatch.setattr(er, "SessionLocal", boom)
    stored = {"Authorization": "Bearer x"}
    assert er.resolve_session_headers(_sess(OR_BASE, stored)) == stored


# ---- persistence ---------------------------------------------------------------------

def test_persist_helper_strips_only_when_an_endpoint_supplies_auth(db):
    _ep(db, "or", OR_BASE, "sk-or")
    h = {"Authorization": "Bearer sk-or", "x-api-key": "k", "X-Keep": "1"}
    assert er.persistable_session_headers(OR_BASE + "/chat/completions", h, "u1") == {"X-Keep": "1"}
    assert er.persistable_session_headers("https://custom.test/v1", h, "u1") == h


def test_session_create_path_writes_no_authorization(db):
    from routes.session_routes import _persist_session_headers
    _ep(db, "or", OR_BASE, "sk-or")
    _row(db, "a", OR_BASE + "/chat/completions", {})
    _persist_session_headers("a", {"Authorization": "Bearer sk-or"})
    assert "Authorization" not in (_stored(db, "a") or {})
    assert "sk-or" not in str(_stored(db, "a"))
    # Custom key on an unresolvable URL is kept (nothing else would supply it).
    _row(db, "b", "https://custom.test/v1/chat/completions", {})
    _persist_session_headers("b", {"Authorization": "Bearer custom"})
    assert _stored(db, "b") == {"Authorization": "Bearer custom"}


def test_fallback_switch_path_writes_no_authorization(db, monkeypatch):
    import requests
    from routes.chat_helpers import try_fallback_endpoint
    _ep(db, "ds", DS_BASE, "sk-ds")
    _row(db, "s1", "https://dead.test/v1/chat/completions", {"Authorization": "Bearer old"})

    class R:
        def raise_for_status(self): pass
        def json(self): return {"data": [{"id": "deepseek-chat"}]}
    monkeypatch.setattr(requests, "get", lambda *a, **k: R())
    sess = _sess("https://dead.test/v1/chat/completions", {"Authorization": "Bearer old"})
    out = try_fallback_endpoint(sess, "s1")
    assert out and out["model"] == "deepseek-chat"
    assert "sk-ds" not in str(_stored(db, "s1"))
    assert "Authorization" not in (_stored(db, "s1") or {})
    # ...yet the live session still sends the right key.
    assert er.resolve_session_headers(sess)["Authorization"] == "Bearer sk-ds"


# ---- startup migration -----------------------------------------------------------------

def test_migration_strips_only_resolvable_rows_and_is_idempotent(db):
    _ep(db, "or", OR_BASE, "sk-or")
    _row(db, "res", OR_BASE + "/chat/completions", {"Authorization": "Bearer sk-or", "X-Keep": "1"})
    _row(db, "cust", "https://custom.test/v1/chat/completions", {"Authorization": "Bearer custom"})
    _row(db, "other", OR_BASE, {"Authorization": "Bearer x"}, owner="u2")  # u2 can't see u1's endpoint
    _row(db, "clean", OR_BASE, {})
    assert er.migrate_strip_session_auth_headers() == 1
    assert _stored(db, "res") == {"X-Keep": "1"}
    assert _stored(db, "cust") == {"Authorization": "Bearer custom"}
    assert _stored(db, "other") == {"Authorization": "Bearer x"}
    assert _stored(db, "clean") == {}
    assert er.migrate_strip_session_auth_headers() == 0  # idempotent
    assert _stored(db, "res") == {"X-Keep": "1"}


def test_migration_is_wired_into_init():
    src = open(os.path.join(FRONTEND, "core", "database.py")).read()
    inner = src[src.index("def _init_db_inner"):src.index("def init_db")]
    assert "_migrate_strip_session_auth_headers()" in inner


# ---- call sites (deliberate update of the old `headers=sess.headers` shape) ---------------

@pytest.mark.parametrize("rel", [
    "routes/chat_routes.py", "routes/memory_routes.py", "routes/webhook_routes.py",
    "src/ai_interaction.py", "src/bg_monitor.py",
])
def test_no_call_site_sends_raw_stored_session_headers(rel):
    src = open(os.path.join(FRONTEND, rel)).read()
    assert not re.search(r"headers\s*=\s*(sess|session)\.headers\b", src), rel
    assert not re.search(r"headers\s*=\s*getattr\(sess, \"headers\"", src), rel
    assert "resolve_session_headers" in src


def test_chat_routes_agent_loop_and_chat_mode_use_the_resolver():
    src = open(os.path.join(FRONTEND, "routes", "chat_routes.py")).read()
    assert src.count("resolve_session_headers(sess)") >= 4

"""ORW-512 (ORW-483 remainder): a session remembers the registered endpoint it was created on or switched to, so two endpoints
sharing one base URL, both serving the session's model and neither the default, can never leave it without its own key.
Private in-memory DB, fixture keys and documentation-range hosts only; no network."""
import json
import os
import sqlite3
import types

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import core.database as d
from src import endpoint_resolver as er

BASE = "https://gw.example.test/v1"


@pytest.fixture()
def db(monkeypatch):
    eng = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    d.Base.metadata.create_all(eng, tables=[d.ModelEndpoint.__table__, d.Session.__table__])
    S = sessionmaker(bind=eng)
    monkeypatch.setattr(er, "SessionLocal", S)
    import src.settings as st
    monkeypatch.setattr(st, "load_settings", lambda *a, **k: {"default_endpoint_id": ""})
    monkeypatch.setattr(st, "get_user_setting", lambda key, owner="", default=None: {"default_endpoint_id": ""}.get(key, default))
    return S


def _ep(S, ep_id, key):
    with S() as s:
        s.add(d.ModelEndpoint(id=ep_id, name=ep_id, base_url=BASE, api_key=key, is_enabled=True, owner="u1", cached_models=json.dumps(["m-shared"])))
        s.commit()


def _row(S, sid, endpoint_id=None):
    with S() as s:
        s.add(d.Session(id=sid, name="s", endpoint_url=BASE + "/chat/completions", model="m-shared", owner="u1", endpoint_id=endpoint_id))
        s.commit()
    return types.SimpleNamespace(id=sid, endpoint_url=BASE + "/chat/completions", model="m-shared", headers={}, owner="u1")


def test_a_true_tie_resolves_to_the_sessions_own_endpoint(db):
    _ep(db, "first", "sk-test-a")
    _ep(db, "second", "sk-test-b")
    assert er.resolve_session_headers(_row(db, "s-second", endpoint_id="second")).get("Authorization") == "Bearer sk-test-b"
    assert er.resolve_session_headers(_row(db, "s-first", endpoint_id="first")).get("Authorization") == "Bearer sk-test-a"


def test_without_a_stored_endpoint_the_tie_still_stays_unresolved(db):
    _ep(db, "first", "sk-test-a")
    _ep(db, "second", "sk-test-b")
    assert "Authorization" not in (er.resolve_session_headers(_row(db, "s-legacy")) or {})


def test_a_stored_endpoint_that_no_longer_matches_is_ignored(db):
    _ep(db, "first", "sk-test-a")
    _ep(db, "second", "sk-test-b")
    with db() as s:
        s.query(d.ModelEndpoint).filter(d.ModelEndpoint.id == "second").update({"is_enabled": False})
        s.commit()
    # the session's own endpoint is disabled: the lookup falls back to the remaining match, never the disabled key
    assert er.resolve_session_headers(_row(db, "s-gone", endpoint_id="second")).get("Authorization") == "Bearer sk-test-a"


def test_the_migration_adds_a_nullable_column_and_existing_rows_load(tmp_path, monkeypatch):
    path = tmp_path / "app.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT, endpoint_url TEXT, model TEXT)")
    conn.execute("INSERT INTO sessions VALUES ('old', 'n', 'u', 'm')")
    conn.commit(); conn.close()
    monkeypatch.setattr(d, "DATABASE_URL", f"sqlite:///{path}")
    d._migrate_add_session_endpoint_id_column()
    d._migrate_add_session_endpoint_id_column()  # idempotent
    conn = sqlite3.connect(path)
    cols = [r[1] for r in conn.execute("PRAGMA table_info(sessions)").fetchall()]
    assert cols.count("endpoint_id") == 1
    assert conn.execute("SELECT id, endpoint_id FROM sessions").fetchall() == [("old", None)]
    conn.close()


def test_session_create_saves_the_endpoint_id_and_a_switch_rewrites_it(db, monkeypatch):
    from routes import session_routes as sr
    monkeypatch.setattr(sr, "SessionLocal", db)
    _row(db, "s-new")
    sr._persist_session_endpoint_id("s-new", " second ")
    with db() as s:
        assert s.query(d.Session).filter(d.Session.id == "s-new").first().endpoint_id == "second"
    sr._persist_session_endpoint_id("s-new", "")
    with db() as s:
        assert s.query(d.Session).filter(d.Session.id == "s-new").first().endpoint_id is None
    # the create route saves it when a registered endpoint was chosen; the model switch writes it (a raw URL clears it)
    src = open(os.path.join(os.path.dirname(sr.__file__), "session_routes.py"), encoding="utf-8").read()
    assert "_persist_session_endpoint_id(sid, endpoint_id)" in src
    assert 'db_session.endpoint_id = (endpoint_id or "").strip() or None' in src

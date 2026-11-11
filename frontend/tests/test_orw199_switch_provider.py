"""ORW-199 remainder: admin switch-provider route + operator provider visibility.

Private in-memory DB; no model/network call. Roles only (owner "u1"/"u2" are account ids).
"""
import logging
import types

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import core.database as d
from src import endpoint_resolver as er
import routes.admin_provider_routes as apr

SENTINEL = "sk-SENTINEL-do-not-leak-0123"
NEW_BASE = "https://api.newhost.example/v1"


@pytest.fixture()
def env(monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    eng = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    d.Base.metadata.create_all(eng, tables=[d.ModelEndpoint.__table__, d.Session.__table__])
    S = sessionmaker(bind=eng)
    monkeypatch.setattr(er, "SessionLocal", S)
    monkeypatch.setattr(d, "SessionLocal", S)
    mem = {}
    sm = types.SimpleNamespace(sessions=mem)
    with S() as s:
        s.add(d.ModelEndpoint(id="ep", name="ep", base_url=NEW_BASE, api_key=SENTINEL,
                              is_enabled=True, owner="u1"))
        for sid, owner in (("a", "u1"), ("b", "u1"), ("c", "u2")):
            s.add(d.Session(id=sid, name=sid, endpoint_url="https://old.example/v1/chat/completions",
                            model="old", headers={"X-Keep": "1", "Authorization": "Bearer sk-old"},
                            owner=owner))
            mem[sid] = types.SimpleNamespace(model="old", endpoint_url="old", headers={}, owner=owner)
        s.add(d.Session(id="arch", name="arch", endpoint_url="old", model="old", headers={},
                        owner="u1", archived=True))
        s.commit()
    monkeypatch.setattr(apr, "_game_session_ids", lambda: {"a", "b", "c", "arch"})
    app = FastAPI()
    app.include_router(apr.setup_admin_provider_routes(sm))
    return types.SimpleNamespace(S=S, mem=mem, client=TestClient(app, raise_server_exceptions=False))


def _row(S, sid):
    with S() as s:
        r = s.get(d.Session, sid)
        return r.model, r.endpoint_url, r.headers


def _post(env, **body):
    return env.client.post("/api/admin/sessions/switch-provider", json=body)


def test_switch_updates_db_and_memory_without_key(env, caplog):
    caplog.set_level(logging.DEBUG)
    r = _post(env, endpoint_id="ep", model="new-model", owner="u1")
    assert r.status_code == 200
    assert r.json() == {"updated": 2, "provider": "api.newhost.example", "model": "new-model"}
    for sid in ("a", "b"):
        model, url, hdrs = _row(env.S, sid)
        assert (model, url) == ("new-model", NEW_BASE + "/chat/completions")
        assert hdrs == {"X-Keep": "1"}  # key not persisted, old provider's auth dropped
        m = env.mem[sid]
        assert (m.model, m.endpoint_url, m.headers) == (model, url, hdrs)
    assert _row(env.S, "c")[0] == "old"          # other owner untouched
    assert _row(env.S, "arch")[0] == "old"       # archived untouched
    assert SENTINEL not in r.text and SENTINEL not in caplog.text
    assert "Bearer" not in r.text


def test_default_scope_is_all_game_sessions_but_refuses_invisible_endpoint(env):
    # c is owned by u2; the endpoint is u1's private row -> whole switch refused, nothing changes.
    r = _post(env, endpoint_id="ep", model="new-model")
    assert r.status_code == 403
    assert all(_row(env.S, s)[0] == "old" for s in ("a", "b", "c"))


def test_shared_endpoint_switches_all(env):
    with env.S() as s:
        s.get(d.ModelEndpoint, "ep").owner = None
        s.commit()
    assert _post(env, endpoint_id="ep", model="m2").json()["updated"] == 3


def test_other_owner_endpoint_refused(env):
    r = _post(env, endpoint_id="ep", model="m2", owner="u2")
    assert r.status_code == 403
    assert _row(env.S, "c")[0] == "old"


def test_disabled_and_missing_endpoint_refused(env):
    with env.S() as s:
        s.get(d.ModelEndpoint, "ep").is_enabled = False
        s.commit()
    assert _post(env, endpoint_id="ep", model="m2", owner="u1").status_code == 404
    assert _post(env, endpoint_id="nope", model="m2").status_code == 404
    assert _row(env.S, "a")[0] == "old"


def test_rollback_when_one_update_fails(env, monkeypatch):
    real = apr._set_fields
    calls = {"n": 0}

    def flaky(row, model, url, headers):
        calls["n"] += 1
        real(row, model, url, headers)
        if calls["n"] == 2:
            raise RuntimeError("boom")

    monkeypatch.setattr(apr, "_set_fields", flaky)
    r = _post(env, endpoint_id="ep", model="m2", owner="u1")
    assert r.status_code == 500
    assert all(_row(env.S, s)[0] == "old" for s in ("a", "b", "c"))
    assert env.mem["a"].model == "old"
    assert SENTINEL not in r.text


def test_non_admin_refused(env, monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "true")
    assert _post(env, endpoint_id="ep", model="m2").status_code == 403
    assert _row(env.S, "a")[0] == "old"


def test_provider_host_is_host_only():
    assert apr.provider_host("https://user:pw@api.x.example:8443/v1/chat?key=sk-1") == "api.x.example:8443"
    assert apr.provider_host("") == ""

"""A42 (#1599 - no silent fail-soft): the five TODO(#1599) sites that used to only LOG now raise the RED-eligible health event on /admin/status.

  server : the post-createCharacter beatSeq refresh failure (tool_implementations.do_create_character)
  client : ws-resync heal, ws-resync reconcile failure, engine beatSeq backwards, reconnect-run-gone, chat-subscribe refused
           (each reports through the existing /api/orwell/fe-report beacon with an ALLOWLISTED surface + red:true; the server records it on the same ring as every other #1599 swallow)

Fault injection per site (the server one drives the real path; the client sites are pinned at the call site and exercised through the real beacon route). Roles only."""
import asyncio
import importlib
import json
import os

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

log_rings = importlib.import_module("src.log_rings")
orwell_routes = importlib.import_module("routes.orwell_routes")
ti = importlib.import_module("src.tool_implementations")
ch = importlib.import_module("routes.chat_helpers")

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(*parts):
    with open(os.path.join(BASE, *parts), encoding="utf-8") as f:
        return f.read()


def _clear():
    for ring in (log_rings.OVERSEER, log_rings.LIVE):
        ring.buf.clear()


def _overseer():
    _, lines = log_rings.OVERSEER.since(0, limit=100000)
    return lines


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(orwell_routes.setup_orwell_routes())
    return TestClient(app, raise_server_exceptions=False)


# ── server site: the post-createCharacter beatSeq refresh ────────────────────────────────────────

def test_post_create_beatseq_refresh_failure_raises_a_red_event(monkeypatch):
    _clear()
    oe = importlib.import_module("src.orwell_engine")

    async def _create(*a, **k):
        return {"started": True, "beatSeq": 71, "house": [], "portraitPrompts": []}

    monkeypatch.setattr(oe, "create_character", _create)
    monkeypatch.setattr(oe, "remember_pending", lambda *a, **k: None)
    monkeypatch.setattr(ch, "_refresh_beat_seq", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("beat store unavailable")))
    res = asyncio.get_event_loop().run_until_complete(ti.do_create_character('{"playerName": "role-player"}', owner="a42-owner"))
    assert isinstance(res, dict) and "started" in (res.get("output") or "")  # the turn still stands
    red = [e for e in _overseer() if e["kind"] == "sync:post-create-beatseq"]
    assert red and red[0]["ok"] is False, "the failed refresh must be a RED-eligible health event, not only a log line"
    assert log_rings.SOFT_FAIL_AUTOCORRECTED in red[0]["diagnosis"] and "beat store unavailable" in red[0]["diagnosis"]


# ── client sites: the beacon route raises RED only for the allowlisted surfaces ──────────────────

CLIENT_SITES = [
    ("ws:resync-heal", "reason=engine-restart", "history reconcile"),
    ("ws:resync-reconcile-failed", "ReconcileThrew", ""),
    ("ws:beat-backwards", "10 -> 4", "heal downward + resync"),
    ("ws:reconnect-run-gone", "RunGoneOnReconnect", "ws-resync history reconcile"),
    ("ws:chat-subscribe-refused", "SubscribeRefused", "SSE fallback"),
]


@pytest.mark.parametrize("surface,detail,corrected", CLIENT_SITES)
def test_each_client_site_raises_a_red_event_through_the_beacon(client, monkeypatch, surface, detail, corrected):
    monkeypatch.setattr(orwell_routes, "_current_user", lambda request: "role-user")  # ORW-396: RED needs a logged-in user
    _clear()
    body = {"surface": surface, "errorClass": "A42Probe", "detail": detail, "red": True}
    if corrected:
        body["corrected"] = corrected
    assert client.post("/api/orwell/fe-report", json=body).status_code == 204
    red = [e for e in _overseer() if e["kind"] == "client:" + surface]
    assert red and red[0]["ok"] is False, f"{surface} must raise a RED-eligible event"
    if corrected:
        assert log_rings.SOFT_FAIL_AUTOCORRECTED in red[0]["diagnosis"]
    else:
        assert log_rings.SOFT_FAIL_UNCORRECTED in red[0]["diagnosis"]


def test_a_non_allowlisted_surface_or_a_missing_red_flag_never_raises_red(client, monkeypatch):
    monkeypatch.setattr(orwell_routes, "_current_user", lambda request: "role-user")
    _clear()
    client.post("/api/orwell/fe-report", json={"surface": "made-up-surface", "errorClass": "x", "detail": "y", "red": True})
    client.post("/api/orwell/fe-report", json={"surface": "ws:beat-backwards", "errorClass": "x", "detail": "y"})  # allowlisted but no red flag
    assert _overseer() == [], "a player-context beacon must not be able to light the God-Mode alarm with an arbitrary surface or without asking"


def test_an_anonymous_red_report_never_raises_red(client):
    _clear()
    body = {"surface": "ws:beat-backwards", "errorClass": "x", "detail": "y", "red": True}
    assert client.post("/api/orwell/fe-report", json=body).status_code == 204
    assert _overseer() == [], "a logged-out beacon must not be able to light the God-Mode alarm"


def test_fe_report_rejects_on_content_length_without_reading(client, monkeypatch):
    monkeypatch.setattr(orwell_routes, "_current_user", lambda request: "role-user")
    _clear()
    ok = {"surface": "ws:beat-backwards", "errorClass": "x", "detail": "y", "red": True}
    big = dict(ok, detail="z" * 20000)
    assert client.post("/api/orwell/fe-report", json=big).status_code == 204
    # no Content-Length (chunked) -> dropped unread, even though the body is a valid RED report
    assert client.post("/api/orwell/fe-report", content=iter([json.dumps(ok).encode()])).status_code == 204
    assert _overseer() == []
    # a lying small header with a big body is also capped
    r = client.post("/api/orwell/fe-report", content=b"{" + b" " * 20000 + b"}", headers={"content-length": "10"})
    assert r.status_code == 204 and _overseer() == []


# ── the call sites really report red, and the TODOs are gone ────────────────────────────────────

def test_the_client_call_sites_report_red_and_no_todo_1599_remains():
    splice = _read("static", "js", "chatWsSplice.js")
    ws = _read("static", "js", "orwellWs.js")
    for surface, src in (("ws:resync-heal", splice), ("ws:resync-reconcile-failed", splice), ("ws:beat-backwards", ws),
                         ("ws:reconnect-run-gone", ws), ("ws:chat-subscribe-refused", ws)):
        assert f"OrwellReport.fail('{surface}'" in src, f"{surface}: the fail-soft site must report through OrwellReport.fail"
    for f in (splice, ws, _read("src", "tool_implementations.py")):
        assert "TODO(#1599)" not in f
    report = _read("static", "js", "orwellReport.js")
    assert "opts && opts.red" in report


# ── ORW-437 review fixes (#2684, #2700): the real session user on the auth-exempt beacon, and a capped read ──

def test_a_logged_in_red_report_raises_red_through_the_real_session_cookie(tmp_path):
    """#2700: /fe-report is auth-exempt, so AuthMiddleware never sets request.state.current_user; the handler must resolve the
    session user from the cookie itself, else the client RED events are silently disabled in production."""
    from core.auth import AuthManager
    from routes.auth_routes import SESSION_COOKIE
    am = AuthManager(auth_path=str(tmp_path / "auth.json"))
    am._config["users"] = {"role-user": {}}  # validate_token drops a session whose user record is gone
    am._config["users"] = {"role-user": {}}  # validate_token drops a session whose user record is gone
    token = am.create_session_trusted("role-user")
    app = FastAPI()
    app.state.auth_manager = am
    app.include_router(orwell_routes.setup_orwell_routes())  # no middleware: exactly what an auth-exempt path sees
    c = TestClient(app, raise_server_exceptions=False)
    _clear()
    body = {"surface": "ws:beat-backwards", "errorClass": "x", "detail": "y", "red": True}
    assert c.post("/api/orwell/fe-report", json=body, cookies={SESSION_COOKIE: token}).status_code == 204
    assert any(e["kind"] == "client:ws:beat-backwards" for e in _overseer()), "a logged-in RED beacon must reach the overseer ring"
    _clear()
    assert c.post("/api/orwell/fe-report", json=body, cookies={SESSION_COOKIE: "forged-token"}).status_code == 204
    assert _overseer() == [], "an invalid session cookie must not raise RED"


def test_fe_report_stops_reading_at_the_cap_and_logs_nothing(client, caplog):
    """#2684: a lying small Content-Length with a valid-JSON body padded past 16 KB is dropped (the read is capped), not parsed."""
    import logging
    ok = json.dumps({"surface": "ws:capped-probe", "errorClass": "x", "detail": "y"}).encode()
    padded = ok + b" " * 40000
    with caplog.at_level(logging.DEBUG):
        r = client.post("/api/orwell/fe-report", content=padded, headers={"content-length": "10"})
    assert r.status_code == 204
    assert "ws:capped-probe" not in caplog.text, "an over-cap body must be dropped, never parsed and logged"


def test_fe_report_client_abort_mid_read_is_204_not_500(client, monkeypatch):
    """review of #2745: a stream error while the body is being read (the client went away mid-upload) is silence (204), never a 500, and nothing is logged as a report."""
    from starlette.requests import ClientDisconnect, Request

    async def broken_stream(self):
        yield b'{"surface": "ws:abort-probe"'
        raise ClientDisconnect()

    monkeypatch.setattr(Request, "stream", broken_stream)
    _clear()
    r = client.post("/api/orwell/fe-report", content=b'{"surface": "ws:abort-probe", "errorClass": "x", "detail": "y"}')
    assert r.status_code == 204
    assert _overseer() == []


def test_a_benign_count_beacon_is_tallied_not_logged_as_fe_fail(client):
    """ORW-1023: a counted benign event logs no [fe-fail] line, is tallied for an allowlisted surface only, and cannot raise RED."""
    _clear()
    body = {"surface": "ws:resync-heal-benign", "errorClass": "run-started-empty", "detail": "speculative holder torn down", "count": True}
    assert client.post("/api/orwell/fe-report", json=body).status_code == 204
    assert client.post("/api/orwell/fe-report", json=dict(body, surface="arbitrary:surface")).status_code == 204
    _, lines = log_rings.LIVE.since(0, limit=100000)
    assert not any("run-started-empty" in str(l) and "fe-fail" in str(l) for l in lines)
    assert _overseer() == []

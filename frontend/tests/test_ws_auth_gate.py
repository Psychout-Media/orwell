"""WebSocket auth gate + ghost-session owner check.

What was wrong: the HTTP ``AuthMiddleware`` does not wrap a WebSocket, so with ``AUTH_ENABLED=true`` a
socket that resolved NO user was still accepted (into the shared ``None`` bucket) and, for an id with no
persisted row, ``_ws_owns`` answered True even when an in-memory session of ANOTHER user held that id
(``session_routes._verify_session_owner`` refuses that case).

Pins: unauthenticated socket (auth on) is closed 1008 at the handshake with nothing accepted or sent; a
logged-in socket, a reconnect, and the auth-off single-tenant mode behave as before; a ghost session owned
by someone else is not ownable. Roles only; no names.
"""
import asyncio
import importlib
import types

import pytest

from tests.support import ws_harness as H

ws_routes = importlib.import_module("routes.ws_routes")
ogs = importlib.import_module("src.orwell_game_session")
auth_routes = importlib.import_module("routes.auth_routes")


@pytest.fixture(autouse=True)
def _tmp_store(tmp_path, monkeypatch):
    monkeypatch.setattr(ogs, "GAME_SESSION_PATH", tmp_path / "orwell_game_session.json")
    H.reset_runs()
    yield
    H.reset_runs()


class _AuthMgr:
    """The two calls ``_ws_current_user`` makes: token → username."""
    def __init__(self, tokens):
        self._tokens = tokens

    def validate_token(self, token):
        return token in self._tokens

    def get_username_for_token(self, token):
        return self._tokens.get(token)


def _ws(cookies=None, tokens=None):
    app = types.SimpleNamespace(state=types.SimpleNamespace(auth_manager=_AuthMgr(tokens or {})))
    return H.FakeWebSocket(cookies=cookies, app=app)


def _engine(monkeypatch):
    async def _state(user):
        return {"started": False, "beatSeq": 0}
    monkeypatch.setattr(ws_routes, "_engine_state", _state)
    monkeypatch.setattr(ws_routes, "_is_live", lambda sid: True)


def test_unauthenticated_socket_is_closed_1008_when_auth_is_on(run, monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "true")
    _engine(monkeypatch)

    async def main():
        ws = _ws(cookies={})                                   # no session cookie
        t = H.spawn(ws)
        ws.client_send({"t": "hello", "cid": "c_00", "d": {"perTabId": "tab"}})   # must never be processed
        await asyncio.wait_for(t, timeout=1.0)
        assert ws.accepted is False and ws.closed is True
        assert ws.close_code == 1008
        assert ws.sent == []                                    # no ack, no error, no frame
        assert ogs.get_game_session(None) is None               # nothing bound in the shared bucket

    run(main())


def test_a_stale_or_forged_cookie_is_closed_1008_too(run, monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "true")
    _engine(monkeypatch)

    async def main():
        ws = _ws(cookies={auth_routes.SESSION_COOKIE: "forged"}, tokens={"real": "A"})
        t = H.spawn(ws)
        await asyncio.wait_for(t, timeout=1.0)
        assert ws.accepted is False and ws.close_code == 1008

    run(main())


def test_logged_in_socket_connects_and_a_reconnect_does_too(run, monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "true")
    _engine(monkeypatch)

    async def main():
        for cid in ("c_first", "c_reconnect"):                  # a reload is a brand-new socket
            ws = _ws(cookies={auth_routes.SESSION_COOKIE: "real"}, tokens={"real": "A"})
            t = H.spawn(ws)
            ack = await H.hello(ws, "tab-A", cid=cid)
            assert ws.accepted is True and ack["t"] == "ack"
            await H.stop(ws, t)

    run(main())


def test_auth_off_single_tenant_socket_is_unchanged(run, monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    _engine(monkeypatch)

    async def main():
        ws = H.new_ws(); t = H.spawn(ws)
        ack = await H.hello(ws, "tab")
        assert ws.accepted is True and ack["t"] == "ack"
        await H.stop(ws, t)

    run(main())


# ── _ws_owns ──────────────────────────────────────────────────────────────────────────────────────

def _ghost(monkeypatch, sid, owner):
    mgr = types.SimpleNamespace(sessions={sid: types.SimpleNamespace(owner=owner)})
    models = importlib.import_module("core.models")
    monkeypatch.setattr(models, "_session_manager", mgr, raising=False)


def test_ws_owns_refuses_a_ghost_session_held_by_another_user(monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "true")
    _ghost(monkeypatch, "ghost-of-B", "B")
    assert ws_routes._ws_owns("A", "ghost-of-B") is False
    assert ws_routes._ws_owns("B", "ghost-of-B") is True       # the owner keeps access


def test_ws_owns_still_admits_a_fresh_per_tab_id_nobody_holds(monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "true")
    _ghost(monkeypatch, "someone-elses", "B")
    assert ws_routes._ws_owns("A", "fresh-per-tab-id-0001") is True


def test_ws_owns_refuses_everything_when_auth_is_on_and_no_user_resolved(monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "true")
    assert ws_routes._ws_owns(None, "fresh-per-tab-id-0001") is False


def test_ws_owns_auth_off_is_always_owned(monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    _ghost(monkeypatch, "ghost-of-B", "B")
    assert ws_routes._ws_owns(None, "ghost-of-B") is True


# ── LOCALHOST_BYPASS (documented dev mode): a DIRECT loopback socket keeps working with auth on ─────
def _fake_ws(host, headers=None):
    return types.SimpleNamespace(client=types.SimpleNamespace(host=host), headers=dict(headers or {}))


def test_localhost_bypass_admits_a_direct_loopback_socket_only(monkeypatch):
    monkeypatch.setenv("LOCALHOST_BYPASS", "true")
    assert ws_routes._ws_localhost_bypass(_fake_ws("127.0.0.1")) is True
    assert ws_routes._ws_localhost_bypass(_fake_ws("203.0.113.9")) is False                     # not loopback
    assert ws_routes._ws_localhost_bypass(_fake_ws("127.0.0.1", {"x-forwarded-for": "203.0.113.9"})) is False  # proxied


def test_localhost_bypass_is_off_by_default(monkeypatch):
    monkeypatch.delenv("LOCALHOST_BYPASS", raising=False)
    assert ws_routes._ws_localhost_bypass(_fake_ws("127.0.0.1")) is False


def test_ws_owns_under_localhost_bypass_is_single_tenant_like_auth_off(monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setenv("LOCALHOST_BYPASS", "true")
    assert ws_routes._ws_owns(None, "fresh-per-tab-id-0001") is True
    monkeypatch.setenv("LOCALHOST_BYPASS", "false")
    assert ws_routes._ws_owns(None, "fresh-per-tab-id-0001") is False

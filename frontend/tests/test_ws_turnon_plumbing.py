"""WS turn-on plumbing (gate #1299) — the two server-side fixes that make the
WebSocket Phase-1 transport UPGRADE-CAPABLE and FLIPPABLE-BY-ENV. It is now ON by
default (ORWELL_WS_TRANSPORT default-ON since 2026-07-10, #1357); an explicit
off/0/false is the rollback lever back to the SSE/poll stack.

Roles only — no houseguest/player names.

  BLOCKER 1 — a WebSocket protocol library is installed, so uvicorn can answer the
              /api/ws/session upgrade instead of 404 "No supported WebSocket library
              detected". (Pinned via requirements.txt/.lock — `websockets`.)
  BLOCKER 3 — app.py emits body[data-ws-transport="1"] whenever ws_transport_enabled()
              is true. Unset ⇒ default ON ⇒ attr PRESENT ⇒ the client engages WS; an
              explicit off/0/false ⇒ attr ABSENT ⇒ rollback to the SSE/poll stack.
"""

import os

import pytest

from src.settings import ws_transport_enabled

FRONTEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ═══════════════════════════════════════════════════════════════════════════
# BLOCKER 1 — a WebSocket library is present (uvicorn auto-detects it)
# ═══════════════════════════════════════════════════════════════════════════

def test_a_websocket_library_imports():
    """uvicorn ships no WS impl by default; the explicit `websockets` pin restores
    the upgrade path. If this import fails, /api/ws/session answers 404."""
    import websockets  # noqa: F401  — presence is the whole assertion

    assert websockets.__version__


def test_websockets_is_pinned_in_both_requirement_files():
    """requirements.txt is human intent; requirements.lock.txt is what deploy installs.
    A fresh box installs the LOCK — the pin must live there too or the bug returns."""
    with open(os.path.join(FRONTEND_DIR, "requirements.txt"), encoding="utf-8") as f:
        req = f.read()
    with open(os.path.join(FRONTEND_DIR, "requirements.lock.txt"), encoding="utf-8") as f:
        lock = f.read()
    # Pin EXACTLY in both files so CI == prod (the lock is what deploy installs) and the
    # intent file can't drift to a different version — a bare/range pin would let the two
    # diverge, the CI-vs-prod hazard the requirements.txt header warns about.
    assert "\nwebsockets==16.0\n" in req, "websockets not pinned to ==16.0 in requirements.txt"
    assert "\nwebsockets==16.0\n" in lock, "websockets not pinned to ==16.0 in requirements.lock.txt"


# ═══════════════════════════════════════════════════════════════════════════
# BLOCKER 3a — ORW-44 S4b2: the transport is WebSocket-ONLY in the game build. The ORWELL_WS_TRANSPORT
# rollback flag is gone: ws_transport_enabled() IS the game build, and the env var is ignored.
# ═══════════════════════════════════════════════════════════════════════════

def test_ws_transport_is_on_in_the_game_build(monkeypatch):
    monkeypatch.setenv("ORWELL_GAME_BUILD", "1")
    monkeypatch.delenv("ORWELL_WS_TRANSPORT", raising=False)
    assert ws_transport_enabled() is True


@pytest.mark.parametrize("val", ["0", "false", "no", "off", "", "1", "true"])
def test_the_old_env_flag_no_longer_does_anything(monkeypatch, val):
    # the rollback lever was deleted: neither a falsey nor a truthy value changes the answer
    monkeypatch.setenv("ORWELL_GAME_BUILD", "1")
    monkeypatch.setenv("ORWELL_WS_TRANSPORT", val)
    assert ws_transport_enabled() is True


def test_ws_transport_is_off_outside_the_game_build(monkeypatch):
    monkeypatch.setenv("ORWELL_GAME_BUILD", "0")
    monkeypatch.setenv("ORWELL_WS_TRANSPORT", "1")
    assert ws_transport_enabled() is False


# ═══════════════════════════════════════════════════════════════════════════
# BLOCKER 3b — the served page: the ws hook is present in the game build, absent in the non-game build
# ═══════════════════════════════════════════════════════════════════════════

class _StubRequest:
    """Minimal stand-in for a Starlette Request — the serve helper only reads
    request.state.csp_nonce."""

    class _State:
        csp_nonce = ""

    state = _State()


def _render_index(monkeypatch, *, game_build: bool) -> str:
    monkeypatch.setenv("ORWELL_GAME_BUILD", "1" if game_build else "0")
    monkeypatch.delenv("ORWELL_WS_TRANSPORT", raising=False)
    from app import _serve_html_with_nonce, BASE_DIR
    from src.app_helpers import abs_join

    resp = _serve_html_with_nonce(_StubRequest(), abs_join(BASE_DIR, "static/index.html"))
    return resp.body.decode("utf-8")


def test_ws_transport_attr_present_in_the_game_build(monkeypatch):
    html = _render_index(monkeypatch, game_build=True)
    assert 'data-ws-transport="1"' in html
    assert 'data-game-build="1"' in html


def test_ws_transport_attr_absent_outside_the_game_build(monkeypatch):
    html = _render_index(monkeypatch, game_build=False)
    assert "data-ws-transport" not in html   # the non-game build keeps the SSE/poll stack and never attempts the upgrade
    assert 'data-game-build="1"' not in html

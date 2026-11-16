"""Feature 0067 / ADR 0007 — Host-header pin via TrustedHostMiddleware.

Builds a throwaway app with just the middleware (no app.py boot) and proves a Host outside the
allow-list is rejected while the configured domain is accepted; the default ["*"] accepts any Host.
"""
import pytest

from core.middleware import allowed_hosts_from_env

pytest.importorskip("fastapi")
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from starlette.middleware.trustedhost import TrustedHostMiddleware  # noqa: E402


def _app(env):
    app = FastAPI()
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts_from_env(env))

    @app.get("/")
    def root():
        return {"ok": True}

    return app


def test_rejects_host_outside_allowlist():
    client = TestClient(_app({"ALLOWED_HOSTS": "hiorwell.com"}), base_url="http://hiorwell.com")
    r = client.get("/", headers={"host": "evil.example"})
    assert r.status_code == 400


def test_accepts_configured_host():
    client = TestClient(_app({"ALLOWED_HOSTS": "hiorwell.com"}), base_url="http://hiorwell.com")
    assert client.get("/").status_code == 200


def test_wildcard_default_accepts_any_host():
    client = TestClient(_app({}))  # default ["*"]
    assert client.get("/", headers={"host": "anything.example"}).status_code == 200


def test_orw465_a_port_in_an_allowed_hosts_entry_is_dropped_so_the_site_still_answers():
    # Starlette compares the Host WITHOUT its port, so "game.example.com:8443" as an entry matched nothing and refused every request
    from core.middleware import allowed_hosts_from_env
    assert allowed_hosts_from_env({"ALLOWED_HOSTS": "game.example.com:8443"}) == ["game.example.com"]
    assert allowed_hosts_from_env({"ALLOWED_HOSTS": "a.example.com:443, b.example.com ,*.c.example.com:8080"}) == ["a.example.com", "b.example.com", "*.c.example.com"]
    assert allowed_hosts_from_env({"ALLOWED_HOSTS": "[::1]:8443,localhost"}) == ["[::1]", "localhost"]
    assert allowed_hosts_from_env({"ALLOWED_HOSTS": "game.example.com"}) == ["game.example.com"]
    assert allowed_hosts_from_env({"ALLOWED_HOSTS": ":8443"}) == [":8443"], "nothing to strip down to: left as written"
    # and the real middleware answers a request whose Host carries that port
    app = FastAPI()

    @app.get("/")
    def _ok():
        return {"ok": True}
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts_from_env({"ALLOWED_HOSTS": "game.example.com:8443"}))
    assert TestClient(app, base_url="http://game.example.com:8443").get("/").status_code == 200
    assert TestClient(app, base_url="http://other.example.com:8443").get("/").status_code == 400

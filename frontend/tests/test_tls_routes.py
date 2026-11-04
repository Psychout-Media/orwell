"""Feature 0074 / ADR 0014 — Admin "Local HTTPS" routes.

Proves the BACKEND ROUTES lane against a throwaway app (just the new router mounted — no full-app
boot), mirroring test_public_deployment_routes:

  * apply with NO valid host names → 400 (fail closed);
  * apply with local names (watcher present) → writes the existence-only flag + the non-secret
    tls.json (NO token) and returns {started:true};
  * apply with a domain + DNS provider + token → writes the 0600 token sidecar AND never leaks it
    into the non-secret config;
  * a domain WITHOUT a DNS token is dropped (a domain block needs DNS-01 to issue);
  * the status route NEVER returns the token and reports the posture;
  * all three routes are admin-gated (403 under AUTH_ENABLED=true with no admin identity);
  * disconnect writes its config + flag.

The deploy data dir is resolved through the SAME DATA_DIR env the module's helpers read, pointed at a
tmp dir; the watcher probe reads this lane's OWN unit override (ORWELL_TLS_WATCHER_UNIT).
Name-agnostic: "admin"/"user" are ACCOUNT ROLES, never houseguests.
"""
import importlib
import json
import os
import stat

from fastapi import FastAPI
from fastapi.testclient import TestClient

atr = importlib.import_module("routes.admin_tls_routes")


def _app():
    app = FastAPI()
    app.include_router(atr.setup_admin_tls_routes())
    return app


def _client():
    return TestClient(_app(), raise_server_exceptions=False)


def _wire_ops(monkeypatch, tmp_path, *, watcher_installed: bool):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    unit = tmp_path / "orwell-ops-tls.path"
    if watcher_installed:
        unit.write_text("[Path]\n")
    elif unit.exists():
        unit.unlink()
    monkeypatch.setenv("ORWELL_TLS_WATCHER_UNIT", str(unit))   # the lane's OWN unit, not the Update lane's
    return tmp_path / "ops"


# --------------------------------------------------------------------------- admin gating

def test_all_routes_admin_gated(monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "true")
    client = _client()
    assert client.get("/api/admin/tls-status").status_code == 403
    assert client.post("/api/admin/tls/apply",
                       json={"localNames": ["orwell.lan"]}).status_code == 403
    assert client.post("/api/admin/tls/disconnect").status_code == 403


# --------------------------------------------------------------------------- apply: fail closed

def test_apply_no_valid_names_400_and_writes_nothing(monkeypatch, tmp_path):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    ops = _wire_ops(monkeypatch, tmp_path, watcher_installed=True)
    client = _client()
    # All-invalid names (spaces/metacharacters) → nothing valid → 400, nothing written.
    r = client.post("/api/admin/tls/apply", json={"localNames": ["bad name", "a;b", "x/y"]})
    assert r.status_code == 400
    assert not (ops / "tls-requested").exists()
    assert not (ops / "tls.json").exists()
    assert not (ops / "tls-dns-token").exists()


# --------------------------------------------------------------------------- apply: local names

def test_apply_local_names_writes_flag_and_config_no_token(monkeypatch, tmp_path):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    ops = _wire_ops(monkeypatch, tmp_path, watcher_installed=True)
    client = _client()

    r = client.post("/api/admin/tls/apply", json={"localNames": ["orwell.lan", "orwell.local"]})
    assert r.status_code == 200
    body = r.json()
    assert body["started"] is True and body["via"] == "flag-trigger" and body["log"] == "ops-tls.log"

    assert (ops / "tls-requested").exists()
    cfg = json.loads((ops / "tls.json").read_text())
    assert cfg["action"] == "apply"
    assert cfg["mode"] == "local"
    assert cfg["localNames"] == ["orwell.lan", "orwell.local"]
    assert cfg["domains"] == []
    assert cfg["hasToken"] is False
    assert not (ops / "tls-dns-token").exists()


# --------------------------------------------------------------------------- apply: domain + DNS token

def test_apply_domain_writes_token_0600_and_no_leak(monkeypatch, tmp_path):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    ops = _wire_ops(monkeypatch, tmp_path, watcher_installed=True)
    client = _client()

    r = client.post("/api/admin/tls/apply", json={
        "localNames": ["orwell.lan"],
        "domains": ["hiorwell.com", "www.hiorwell.com"],
        "dnsProvider": "cloudflare",
        "dnsApiToken": "dns-secret-xyz",
    })
    assert r.status_code == 200 and r.json()["started"] is True

    cfg = json.loads((ops / "tls.json").read_text())
    assert cfg["domains"] == ["hiorwell.com", "www.hiorwell.com"]
    assert cfg["dnsProvider"] == "cloudflare"
    assert cfg["hasToken"] is True
    # The token must NOT leak into the non-secret config (any key/value).
    assert "dns-secret-xyz" not in json.dumps(cfg)

    token_path = ops / "tls-dns-token"
    assert token_path.read_text() == "dns-secret-xyz"
    assert stat.S_IMODE(os.stat(token_path).st_mode) == 0o600


def test_apply_domain_without_token_is_dropped(monkeypatch, tmp_path):
    # A domain block needs DNS-01 (provider + token) to issue a publicly-trusted cert. Without the
    # token, the domain is dropped (local names still apply) — never a config that cannot issue.
    monkeypatch.setenv("AUTH_ENABLED", "false")
    ops = _wire_ops(monkeypatch, tmp_path, watcher_installed=True)
    client = _client()

    r = client.post("/api/admin/tls/apply", json={
        "localNames": ["orwell.lan"], "domains": ["hiorwell.com"], "dnsProvider": "cloudflare"})
    assert r.status_code == 200 and r.json()["started"] is True
    cfg = json.loads((ops / "tls.json").read_text())
    assert cfg["domains"] == []
    assert not (ops / "tls-dns-token").exists()


def test_apply_fails_loud_without_watcher(monkeypatch, tmp_path):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    ops = _wire_ops(monkeypatch, tmp_path, watcher_installed=False)
    client = _client()
    r = client.post("/api/admin/tls/apply", json={"localNames": ["orwell.lan"]})
    assert r.status_code == 200
    body = r.json()
    assert body["started"] is False and body["via"] == "none"
    assert "no privileged path" in body["error"]
    status = json.loads((ops / "tls-status.json").read_text())
    assert status["ok"] is False and status["running"] is False
    assert status["message"].startswith("FAILED:")


# --------------------------------------------------------------------------- status: never the token

def test_status_never_returns_token_and_reports_posture(monkeypatch, tmp_path):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    ops = _wire_ops(monkeypatch, tmp_path, watcher_installed=True)
    ops.mkdir(parents=True, exist_ok=True)
    (ops / "tls-dns-token").write_text("super-secret-never-echo")
    (ops / "tls.json").write_text(json.dumps(
        {"action": "apply", "domains": ["hiorwell.com"]}))

    monkeypatch.setenv("ORWELL_TLS_MODE", "local")
    monkeypatch.setenv("ORWELL_TLS_LOCAL_NAMES", "orwell.lan,orwell.local")
    monkeypatch.setenv("ORWELL_TLS_DNS_API_TOKEN", "another-secret")
    monkeypatch.setenv("SECURE_COOKIES", "true")
    monkeypatch.setattr(atr.shutil, "which", lambda _name: "/usr/bin/caddy")
    monkeypatch.setattr(atr, "_caddy_active", lambda: True)

    r = _client().get("/api/admin/tls-status")
    assert r.status_code == 200
    body = r.json()
    blob = json.dumps(body)
    assert "super-secret-never-echo" not in blob
    assert "another-secret" not in blob

    assert body["mode"] == "local"
    assert body["localNames"] == ["orwell.lan", "orwell.local"]
    assert body["domains"] == ["hiorwell.com"]
    assert body["dnsConfigured"] is True          # a token is set — reported as a bool, never echoed
    assert body["secureCookies"] is True
    assert body["caddy"]["installed"] is True
    assert body["caddy"]["active"] is True
    assert body["rootCa"]["downloadUrl"] == "/orwell-local-ca.crt"


def test_status_defaults_when_unset(monkeypatch, tmp_path):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    _wire_ops(monkeypatch, tmp_path, watcher_installed=True)
    for key in ("ORWELL_TLS_MODE", "ORWELL_TLS_LOCAL_NAMES", "ORWELL_TLS_DNS_API_TOKEN", "SECURE_COOKIES"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(atr.shutil, "which", lambda _name: None)
    monkeypatch.setattr(atr, "_caddy_active", lambda: False)

    body = _client().get("/api/admin/tls-status").json()
    assert body["mode"] == "off"
    assert body["localNames"] == ["orwell.lan", "orwell.local"]   # the default
    assert body["dnsConfigured"] is False
    assert body["caddy"]["installed"] is False
    assert body["lastApply"] is None


# --------------------------------------------------------------------------- disconnect

def test_disconnect_writes_flag(monkeypatch, tmp_path):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    ops = _wire_ops(monkeypatch, tmp_path, watcher_installed=True)
    r = _client().post("/api/admin/tls/disconnect")
    assert r.status_code == 200 and r.json()["started"] is True
    assert (ops / "tls-requested").exists()
    cfg = json.loads((ops / "tls.json").read_text())
    assert cfg["action"] == "disable"


# --------------------------------------------------------------------------- apply: control chars

def test_apply_rejects_control_characters_and_writes_nothing(monkeypatch, tmp_path):
    # Names + provider become flags for the root script, the token an env value. A control character
    # (newline above all) is rejected outright — 400 naming the field, nothing written.
    monkeypatch.setenv("AUTH_ENABLED", "false")
    ops = _wire_ops(monkeypatch, tmp_path, watcher_installed=True)
    client = _client()
    cases = [
        ("localNames", {"localNames": ["orwell.lan\nevil.lan"]}),
        ("localNames", {"localNames": "orwell.lan\r\n"}),
        ("domains", {"localNames": ["orwell.lan"], "domains": ["a.example.com\x00"]}),
        ("dnsProvider", {"localNames": ["orwell.lan"], "dnsProvider": "cloudflare\n"}),
        ("dnsApiToken", {"localNames": ["orwell.lan"], "dnsApiToken": "to\nken"}),
    ]
    for field, body in cases:
        r = client.post("/api/admin/tls/apply", json=body)
        assert r.status_code == 400, body
        assert field in r.json()["detail"], body
        assert not (ops / "tls-requested").exists(), body
        assert not (ops / "tls.json").exists(), body
        assert not (ops / "tls-dns-token").exists(), body


def test_tls_name_filter_does_not_accept_trailing_newline():
    # `$` matches just before a trailing newline; the anchor is \Z so "name\n" can never pass.
    from core.middleware import _TLS_NAME_RE
    assert _TLS_NAME_RE.match("orwell.lan")
    assert not _TLS_NAME_RE.match("orwell.lan\n")


# --------------------------------------------------------------------------- wiring

def test_routes_wired_into_app_py():
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    app_py = open(os.path.join(base, "app.py"), encoding="utf-8").read()
    assert "setup_admin_tls_routes" in app_py
    assert "setup_local_ca_routes" in app_py
    # The CA download must be auth-exempt (a fresh device fetches it before login).
    assert "/orwell-local-ca.crt" in app_py


def test_tls_in_ops_status_actions():
    aos = importlib.import_module("routes.admin_ops_status_routes")
    assert "tls" in aos._OPS_ACTIONS

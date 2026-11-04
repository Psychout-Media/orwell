"""Feature 0068 / ADR 0007 — Admin "Public deployment / Connect to the internet" routes.

Proves the BACKEND ROUTES lane against a throwaway app (just the new router mounted — no full-app
boot), mirroring test_admin_update / test_trusted_host:

  * apply with an UNSAFE proposed profile (no domain ⇒ unpinned host) → 400 + the named reason AND
    NOTHING written to the tmp data/ops dir (no flag, no config, no token) — fail closed before any
    write;
  * apply with a SAFE payload (watcher unit present) → writes the existence-only flag + the
    non-secret public-deployment.json + the mode-0600 connector token, and returns {started:true};
  * the status route NEVER returns the token and reports the posture booleans (systemctl/which
    mocked so it doesn't depend on the host);
  * all three routes are admin-gated (403 under AUTH_ENABLED=true with no admin identity);
  * disconnect writes its config + flag.

The deploy data dir is resolved through the SAME DATA_DIR env the module's _data_dir reads, pointed
at a tmp dir; the watcher probe reads the lane's OWN unit override (ORWELL_PUBLIC_DEPLOYMENT_WATCHER_UNIT)
(the Update lane unit is NOT consulted). Name-agnostic: "admin"/"user" are ACCOUNT ROLES, never houseguests.
"""
import importlib
import json
import os
import stat

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

apd = importlib.import_module("routes.admin_public_deployment_routes")


def _app():
    app = FastAPI()
    app.include_router(apd.setup_admin_public_deployment_routes())
    return app


def _client():
    return TestClient(_app(), raise_server_exceptions=False)


def _wire_ops(monkeypatch, tmp_path, *, watcher_installed: bool):
    """Point the shared DATA_DIR at a tmp dir and set the watcher-unit probe present/absent."""
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    unit = tmp_path / "orwell-ops-public-deployment.path"
    if watcher_installed:
        unit.write_text("[Path]\n")
    else:
        # ensure it does NOT exist
        if unit.exists():
            unit.unlink()
    # The lane probes its OWN path unit (not the Update lane's); point it at our unit file.
    monkeypatch.setenv("ORWELL_PUBLIC_DEPLOYMENT_WATCHER_UNIT", str(unit))
    return tmp_path / "ops"


# ---------------------------------------------------------------------------------------------
# admin gating
# ---------------------------------------------------------------------------------------------

def test_all_routes_admin_gated(monkeypatch):
    # AUTH_ENABLED=true with no admin identity → 403 on every route.
    monkeypatch.setenv("AUTH_ENABLED", "true")
    client = _client()
    assert client.get("/api/admin/public-deployment-status").status_code == 403
    assert client.post("/api/admin/public-deployment/apply",
                       json={"domains": ["hiorwell.com"]}).status_code == 403
    assert client.post("/api/admin/public-deployment/disconnect").status_code == 403


# ---------------------------------------------------------------------------------------------
# apply — fail closed on an unsafe profile
# ---------------------------------------------------------------------------------------------

def test_apply_unsafe_profile_400_and_writes_nothing(monkeypatch, tmp_path):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    ops = _wire_ops(monkeypatch, tmp_path, watcher_installed=True)
    client = _client()

    # domains=[] ⇒ ALLOWED_HOSTS="" ⇒ unpinned host ⇒ assert_public_profile_safe raises ⇒ 400.
    r = client.post("/api/admin/public-deployment/apply",
                    json={"domains": [], "tunnelToken": "secret-token-xyz"})
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert "ALLOWED_HOSTS" in detail  # the named reason (unpinned host)

    # NOTHING was written: no flag, no config, no token — fail closed before any write.
    assert not (ops / "public-deployment-requested").exists()
    assert not (ops / "public-deployment.json").exists()
    assert not (ops / "cloudflared-token").exists()


def test_apply_rejects_plaintext_public_bind_host(monkeypatch, tmp_path):
    # DEPLOY-2 (B15): an otherwise-safe payload (domains pinned, etc.) must still fail closed when
    # the BOX'S REAL current ORWELL_BIND_HOST is a public/wildcard interface — e.g. the installer's
    # own LAN-direct default of 0.0.0.0 — because the app would keep serving in the clear on that
    # interface even after "going public" behind a tunnel/proxy.
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setenv("ORWELL_BIND_HOST", "0.0.0.0")
    ops = _wire_ops(monkeypatch, tmp_path, watcher_installed=True)
    client = _client()

    r = client.post("/api/admin/public-deployment/apply",
                    json={"domains": ["hiorwell.com"], "tunnelToken": "secret-token-xyz"})
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert "ORWELL_BIND_HOST" in detail  # the named reason (plaintext-reachable public bind)

    # NOTHING was written: no flag, no config, no token — fail closed before any write.
    assert not (ops / "public-deployment-requested").exists()
    assert not (ops / "public-deployment.json").exists()
    assert not (ops / "cloudflared-token").exists()


@pytest.mark.parametrize("bind", ["127.0.0.1", "::1", "localhost"])
def test_apply_allows_loopback_bind_host(monkeypatch, tmp_path, bind):
    # The counterpart to the rejection above: a loopback bind host (the default, or an operator who
    # already pinned it correctly) is fine and applies normally.
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setenv("ORWELL_BIND_HOST", bind)
    _wire_ops(monkeypatch, tmp_path, watcher_installed=True)
    client = _client()

    r = client.post("/api/admin/public-deployment/apply",
                    json={"domains": ["hiorwell.com"]})
    assert r.status_code == 200
    assert r.json()["started"] is True


# ---------------------------------------------------------------------------------------------
# apply — safe payload writes flag + config + token (mode 0600)
# ---------------------------------------------------------------------------------------------

def test_apply_safe_writes_flag_config_and_token_0600(monkeypatch, tmp_path):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    ops = _wire_ops(monkeypatch, tmp_path, watcher_installed=True)
    client = _client()

    r = client.post("/api/admin/public-deployment/apply",
                    json={"domains": ["hiorwell.com", "www.hiorwell.com"],
                          "tunnelToken": "secret-token-xyz"})
    assert r.status_code == 200
    body = r.json()
    assert body["started"] is True
    assert body["via"] == "flag-trigger"
    assert body["log"] == "ops-public-deployment.log"

    # The existence-only flag the root ops watcher consumes.
    assert (ops / "public-deployment-requested").exists()

    # The non-secret desired-env config — domains + the derived env, NO token.
    config = json.loads((ops / "public-deployment.json").read_text())
    assert config["action"] == "apply"
    assert config["domains"] == ["hiorwell.com", "www.hiorwell.com"]
    assert config["hasToken"] is True
    assert config["env"]["ORWELL_PUBLIC"] == "1"
    assert config["env"]["ALLOWED_HOSTS"] == "hiorwell.com,www.hiorwell.com"
    assert config["env"]["ALLOWED_ORIGINS"] == "https://hiorwell.com"
    assert config["env"]["SECURE_COOKIES"] == "true"
    # The token must NOT leak into the non-secret config (any key/value).
    assert "secret-token-xyz" not in json.dumps(config)

    # The connector token sidecar: exact contents + mode 0600 (no group/other bits).
    token_path = ops / "cloudflared-token"
    assert token_path.read_text() == "secret-token-xyz"
    mode = stat.S_IMODE(os.stat(token_path).st_mode)
    assert mode == 0o600


def test_apply_safe_without_token_writes_no_token_file(monkeypatch, tmp_path):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    ops = _wire_ops(monkeypatch, tmp_path, watcher_installed=True)
    client = _client()

    r = client.post("/api/admin/public-deployment/apply",
                    json={"domains": ["hiorwell.com"]})
    assert r.status_code == 200 and r.json()["started"] is True
    # No tunnelToken ⇒ no token file; config records hasToken=false.
    assert not (ops / "cloudflared-token").exists()
    config = json.loads((ops / "public-deployment.json").read_text())
    assert config["hasToken"] is False


def test_apply_fails_loud_without_watcher(monkeypatch, tmp_path):
    # Safe profile but no root watcher installed → started:false + a FAILED ops-status file (the
    # status page surfaces it) instead of a silent no-op. The config/token still wrote (the proposed
    # combo is safe); only the trigger has no privileged door.
    monkeypatch.setenv("AUTH_ENABLED", "false")
    ops = _wire_ops(monkeypatch, tmp_path, watcher_installed=False)
    client = _client()

    r = client.post("/api/admin/public-deployment/apply",
                    json={"domains": ["hiorwell.com"], "tunnelToken": "t"})
    assert r.status_code == 200
    body = r.json()
    assert body["started"] is False and body["via"] == "none"
    assert "no privileged path" in body["error"]
    status = json.loads((ops / "public-deployment-status.json").read_text())
    assert status["ok"] is False and status["running"] is False
    assert status["message"].startswith("FAILED:")


# ---------------------------------------------------------------------------------------------
# status — never returns the token; reports posture
# ---------------------------------------------------------------------------------------------

def test_status_never_returns_token_and_reports_posture(monkeypatch, tmp_path):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    ops = _wire_ops(monkeypatch, tmp_path, watcher_installed=True)
    # A token sitting on disk from a prior apply must NEVER surface.
    ops.mkdir(parents=True, exist_ok=True)
    (ops / "cloudflared-token").write_text("super-secret-never-echo")
    (ops / "public-deployment.json").write_text(
        json.dumps({"action": "apply", "domains": ["hiorwell.com"]}))

    # Set the public posture and mock host-dependent probes so the test is host-independent.
    monkeypatch.setenv("ORWELL_PUBLIC", "1")
    monkeypatch.setenv("ORWELL_BIND_HOST", "0.0.0.0")
    monkeypatch.setenv("ALLOWED_HOSTS", "hiorwell.com")
    monkeypatch.setenv("SECURE_COOKIES", "true")
    monkeypatch.setattr(apd.shutil, "which", lambda _name: "/usr/local/bin/cloudflared")
    monkeypatch.setattr(apd, "_cloudflared_active", lambda: True)

    r = _client().get("/api/admin/public-deployment-status")
    assert r.status_code == 200
    body = r.json()

    # The token never appears anywhere in the response.
    assert "super-secret-never-echo" not in json.dumps(body)
    assert "token" not in json.dumps(body).lower() or "tunnelToken" not in body

    # Posture booleans.
    assert body["enabled"] is True
    assert body["bindHost"] == "0.0.0.0"
    assert body["allowedHosts"] == ["hiorwell.com"]
    assert body["secureCookies"] is True
    assert body["authEnabled"] is False  # AUTH_ENABLED=false for this happy-path test
    assert body["hostPinned"] is True
    assert body["tunnel"]["installed"] is True
    assert body["tunnel"]["active"] is True
    assert body["tunnel"]["publicUrl"] == "https://hiorwell.com"


def test_status_defaults_when_unset(monkeypatch, tmp_path):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    _wire_ops(monkeypatch, tmp_path, watcher_installed=True)
    for key in ("ORWELL_PUBLIC", "ORWELL_BIND_HOST", "ALLOWED_HOSTS", "SECURE_COOKIES"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(apd.shutil, "which", lambda _name: None)
    monkeypatch.setattr(apd, "_cloudflared_active", lambda: False)

    body = _client().get("/api/admin/public-deployment-status").json()
    assert body["enabled"] is False
    assert body["bindHost"] == "127.0.0.1"          # the default
    assert body["allowedHosts"] == ["*"]            # the wildcard default
    assert body["hostPinned"] is False              # ["*"] is not pinned
    assert body["tunnel"]["installed"] is False
    assert body["tunnel"]["active"] is False
    assert body["lastApply"] is None


# ---------------------------------------------------------------------------------------------
# disconnect — writes its flag
# ---------------------------------------------------------------------------------------------

def test_disconnect_writes_flag(monkeypatch, tmp_path):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    ops = _wire_ops(monkeypatch, tmp_path, watcher_installed=True)
    r = _client().post("/api/admin/public-deployment/disconnect")
    assert r.status_code == 200
    body = r.json()
    assert body["started"] is True and body["via"] == "flag-trigger"
    assert (ops / "public-deployment-requested").exists()
    config = json.loads((ops / "public-deployment.json").read_text())
    assert config["action"] == "disconnect"


def test_routes_wired_into_app_py():
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    app_py = open(os.path.join(base, "app.py"), encoding="utf-8").read()
    assert "setup_admin_public_deployment_routes" in app_py


def test_public_deployment_in_ops_status_actions():
    aos = importlib.import_module("routes.admin_ops_status_routes")
    assert "public-deployment" in aos._OPS_ACTIONS

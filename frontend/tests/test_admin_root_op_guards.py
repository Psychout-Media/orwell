"""Admin routes that trigger ROOT operations — the hardening guards.

What was wrong, and what these pin (every case has a NEGATIVE half; roles only, no names):

  1. A destructive reset trusted a client-side typed "RESET" and a SameSite=Lax cookie. Now the server
     REQUIRES ``{"confirm": "RESET"}`` and refuses a cross-origin request — while plain HTTP by LAN IP and
     a reverse proxy (rewritten Host / ``ALLOWED_ORIGINS``) still work.
  2. ``require_admin`` passes everyone under ``AUTH_ENABLED=false``. Root operations now use
     ``require_root_ops`` (modeled on ``require_vault_reveal``): an admin session, the internal token, or —
     auth off — a DIRECT loopback peer (or an explicit operator opt-in).
  4. A flag dropped for a ``.path`` watcher that is installed but NOT active read as "started". Now the
     route reports failure and queues nothing.
  5. The connector / DNS token was written BEFORE the watcher check, so an early return left it on disk.
"""
import importlib
import os
import re
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from core import admin_guard, ops_watcher

arr = importlib.import_module("routes.admin_reset_routes")
aurr = importlib.import_module("routes.admin_update_reset_routes")
aur = importlib.import_module("routes.admin_update_routes")
apd = importlib.import_module("routes.admin_public_deployment_routes")
atr = importlib.import_module("routes.admin_tls_routes")
ahr = importlib.import_module("routes.admin_health_routes")

FE = Path(__file__).resolve().parent.parent
REPO = FE.parent

# (path, unit env override, flag file) for each route that hands a flag to a root watcher.
LANES = {
    "factory-reset": ("/api/admin/factory-reset", "ORWELL_OOBE_RESET_WATCHER_UNIT",
                      "orwell-ops-factory-reset.path", "factory-reset-requested"),
    "update-reset": ("/api/admin/update-reset", "ORWELL_UPDATE_RESET_WATCHER_UNIT",
                     "orwell-ops-update-reset.path", "update-reset-requested"),
    "update": ("/api/admin/update", "ORWELL_UPDATE_WATCHER_UNIT",
               "orwell-ops-update.path", "update-requested"),
    "tls-disconnect": ("/api/admin/tls/disconnect", "ORWELL_TLS_WATCHER_UNIT",
                       "orwell-ops-tls.path", "tls-requested"),
    "public-disconnect": ("/api/admin/public-deployment/disconnect",
                          "ORWELL_PUBLIC_DEPLOYMENT_WATCHER_UNIT",
                          "orwell-ops-public-deployment.path", "public-deployment-requested"),
}
CONFIRMED = {"factory-reset", "update-reset"}


def _app():
    app = FastAPI()
    for router in (arr.setup_admin_reset_routes(), aurr.setup_admin_update_reset_routes(),
                   aur.setup_admin_update_routes(), apd.setup_admin_public_deployment_routes(),
                   atr.setup_admin_tls_routes(), ahr.setup_admin_health_routes(),
                   ahr.setup_admin_status_page()):
        app.include_router(router)
    return app


def _client(**kw):
    return TestClient(_app(), raise_server_exceptions=False, **kw)


@pytest.fixture
def box(monkeypatch, tmp_path):
    """A box where every watcher is installed (and, per the conftest default, active), auth is off."""
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    for _name, (_p, env, unit, _f) in LANES.items():
        u = tmp_path / unit
        u.write_text("[Path]\n")
        monkeypatch.setenv(env, str(u))
    for var in ("ORWELL_OOBE_RESET_DIRECT", "ORWELL_UPDATE_RESET_DIRECT", "ORWELL_UPDATE_DIRECT",
                "ORWELL_OOBE_RESET_SUDO", "ORWELL_UPDATE_RESET_SUDO", "ORWELL_UPDATE_SUDO"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.delenv("ALLOWED_ORIGINS", raising=False)

    def _boom(*a, **k):
        raise AssertionError("no process may be spawned: the flag trigger is the only door")
    monkeypatch.setattr(arr.subprocess, "Popen", _boom)
    monkeypatch.setattr(aurr.subprocess, "Popen", _boom)
    monkeypatch.setattr(aur.subprocess, "Popen", _boom)
    return tmp_path


def _post(client, lane, **kw):
    path = LANES[lane][0]
    if lane in CONFIRMED and "json" not in kw:
        kw["json"] = {"confirm": "RESET"}
    return client.post(path, **kw)


def _flag(box, lane) -> Path:
    return box / "ops" / LANES[lane][3]


# ------------------------------------------------------------------ 1. confirmation (server-side)

@pytest.mark.parametrize("lane", sorted(CONFIRMED))
def test_destructive_route_refuses_a_request_without_the_confirmation(box, lane):
    r = _client().post(LANES[lane][0])                      # no body at all
    assert r.status_code == 400 and "confirm" in r.json()["detail"].lower()
    assert not _flag(box, lane).exists()                    # nothing queued


@pytest.mark.parametrize("lane", sorted(CONFIRMED))
@pytest.mark.parametrize("body", [{"confirm": "reset"}, {"confirm": "yes"}, {"confirm": True},
                                  {"confirm": ""}, {"other": "RESET"}, ["RESET"]])
def test_destructive_route_refuses_a_wrong_confirmation(box, lane, body):
    r = _client().post(LANES[lane][0], json=body)
    assert r.status_code == 400
    assert not _flag(box, lane).exists()


@pytest.mark.parametrize("lane", sorted(CONFIRMED))
def test_destructive_route_accepts_the_typed_phrase_even_with_stray_whitespace(box, lane):
    r = _client().post(LANES[lane][0], json={"confirm": "  RESET "})
    assert r.status_code == 200 and r.json()["started"] is True
    assert _flag(box, lane).exists()


def test_status_page_sends_the_confirmation_with_both_destructive_posts():
    page = ahr._STATUS_PAGE
    for endpoint in ("/api/admin/factory-reset", "/api/admin/update-reset"):
        call = page[page.index(endpoint):][:400]
        assert "JSON.stringify({ confirm: typed.trim() })" in call and "application/json" in call


# ------------------------------------------------------------------ 1. same-origin

@pytest.mark.parametrize("lane", sorted(LANES))
def test_cross_origin_request_is_refused_and_queues_nothing(box, lane):
    r = _post(_client(), lane, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    assert not _flag(box, lane).exists()


@pytest.mark.parametrize("origin", ["null", "https://testserver.evil.example", "http://testserver:9999",
                                    "javascript:alert(1)", ""])
def test_foreign_or_opaque_origins_are_refused(box, origin):
    r = _post(_client(), "factory-reset", headers={"Origin": origin})
    assert r.status_code == 403 and not _flag(box, "factory-reset").exists()


def test_referer_is_checked_when_origin_is_absent(box):
    assert _post(_client(), "update", headers={"Referer": "https://evil.example/x"}).status_code == 403
    assert _post(_client(), "update", headers={"Referer": "http://testserver/admin/status"}).status_code == 200


def test_sec_fetch_site_cross_site_is_refused_even_without_an_origin(box):
    r = _post(_client(), "update", headers={"Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 403 and not _flag(box, "update").exists()


def test_same_origin_over_plain_http_by_lan_ip_works(box):
    c = _client(base_url="http://192.168.1.20:7000")
    r = _post(c, "factory-reset", headers={"Origin": "http://192.168.1.20:7000"})
    assert r.status_code == 200 and r.json()["started"] is True


def test_same_origin_on_the_default_port_works(box):
    c = _client(base_url="http://orwell.lan:80")
    assert _post(c, "update", headers={"Origin": "http://orwell.lan"}).status_code == 200


def test_a_request_with_no_origin_or_referer_is_a_non_browser_client_and_is_allowed(box):
    assert _post(_client(), "update").status_code == 200


def test_behind_a_proxy_that_rewrites_host_the_forwarded_host_matches(box):
    r = _post(_client(), "update", headers={"Origin": "https://orwell.example.org",
                                            "X-Forwarded-Host": "orwell.example.org",
                                            "X-Forwarded-Proto": "https"})
    assert r.status_code == 200


def test_behind_a_proxy_that_sends_neither_the_allowed_origins_list_admits_it(box, monkeypatch):
    origin = {"Origin": "https://orwell.example.org"}
    assert _post(_client(), "update", headers=origin).status_code == 403
    monkeypatch.setenv("ALLOWED_ORIGINS", "http://localhost,https://orwell.example.org")
    assert _post(_client(), "update", headers=origin).status_code == 200


def test_a_refused_cross_origin_names_the_operator_step():
    with pytest.raises(admin_guard.HTTPException) as e:
        class _R:
            headers = {"origin": "https://x.example", "host": "testserver"}
        admin_guard.require_same_origin(_R())
    assert "ALLOWED_ORIGINS" in e.value.detail


# ------------------------------------------------------------------ 2. strict gate under auth-off

def test_auth_off_refuses_a_non_loopback_peer_by_default(box, monkeypatch):
    monkeypatch.delenv(admin_guard.ROOT_OPS_NO_AUTH_ENV)          # the conftest opt-in, removed
    r = _post(_client(), "factory-reset")                         # TestClient peer is "testclient"
    assert r.status_code == 403 and "authentication" in r.json()["detail"].lower()
    assert not _flag(box, "factory-reset").exists()


def test_auth_off_allows_a_direct_loopback_peer(box, monkeypatch):
    monkeypatch.delenv(admin_guard.ROOT_OPS_NO_AUTH_ENV)
    r = _post(_client(client=("127.0.0.1", 50000)), "factory-reset")
    assert r.status_code == 200 and r.json()["started"] is True


def test_auth_off_loopback_behind_a_proxy_is_not_trusted(box, monkeypatch):
    # cloudflared / a reverse proxy connect FROM loopback but forward the real client's address.
    monkeypatch.delenv(admin_guard.ROOT_OPS_NO_AUTH_ENV)
    r = _post(_client(client=("127.0.0.1", 50000)), "factory-reset",
              headers={"X-Forwarded-For": "203.0.113.9"})
    assert r.status_code == 403


def test_auth_off_operator_opt_in_admits_a_non_loopback_peer(box, monkeypatch):
    monkeypatch.setenv(admin_guard.ROOT_OPS_NO_AUTH_ENV, "1")
    assert _post(_client(), "factory-reset").status_code == 200


@pytest.mark.parametrize("lane", sorted(LANES))
def test_auth_on_without_an_admin_session_is_refused(box, monkeypatch, lane):
    monkeypatch.setenv("AUTH_ENABLED", "true")
    assert _post(_client(client=("127.0.0.1", 1)), lane).status_code == 403
    assert not _flag(box, lane).exists()


def test_internal_tool_token_still_passes_the_gate(box, monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "true")
    r = _post(_client(), "update", headers={"X-Orwell-Internal-Token": admin_guard.INTERNAL_TOOL_TOKEN})
    assert r.status_code == 200


def test_trigger_update_on_the_status_page_uses_the_same_gate(box, monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "true")
    assert _client().post("/api/admin/ops/trigger-update").status_code == 403
    monkeypatch.setenv("AUTH_ENABLED", "false")
    assert _client().post("/api/admin/ops/trigger-update",
                          headers={"Origin": "https://evil.example"}).status_code == 403


# ------------------------------------------------------------------ 4. a watcher must be ACTIVE

@pytest.fixture
def inactive(monkeypatch):
    monkeypatch.setattr(ops_watcher, "_systemctl_is_active", lambda unit: False)


@pytest.mark.parametrize("lane", sorted(LANES))
def test_installed_but_inactive_watcher_reports_failure_and_queues_nothing(box, inactive, lane):
    r = _post(_client(), lane)
    assert r.status_code == 200
    body = r.json()
    assert body["started"] is False and body["via"] == "none"
    assert "not active" in body["error"].lower() and "systemctl enable --now" in body["error"]
    assert not _flag(box, lane).exists()                       # nothing for a later start to fire


def test_trigger_update_reports_inactive_watcher_and_queues_nothing(box, inactive):
    (box / "ops").mkdir()
    body = _client().post("/api/admin/ops/trigger-update").json()
    assert body["triggered"] is False and body["installed"] is False
    assert not _flag(box, "update").exists()
    assert _client().get("/api/admin/ops").json()["updateTrigger"]["installed"] is False


def test_public_and_tls_lanes_probe_their_own_unit_not_the_update_lane(box, monkeypatch):
    # The Update watcher being present must not satisfy the TLS / public-deployment lanes.
    (box / "orwell-ops-tls.path").unlink()
    (box / "orwell-ops-public-deployment.path").unlink()
    assert _post(_client(), "tls-disconnect").json()["started"] is False
    assert _post(_client(), "public-disconnect").json()["started"] is False


def test_systemctl_probe_is_false_when_it_cannot_confirm(monkeypatch, tmp_path):
    monkeypatch.undo()                                          # drop the conftest stub: the REAL probe
    unit = tmp_path / "orwell-ops-update.path"
    unit.write_text("[Path]\n")

    def _missing(*a, **k):
        raise FileNotFoundError("systemctl")
    monkeypatch.setattr(ops_watcher.subprocess, "run", _missing)
    assert ops_watcher.watcher_active(str(unit)) is False       # cannot confirm ⇒ not running
    assert ops_watcher.watcher_active(str(tmp_path / "absent.path")) is False

    class _P:
        stdout = "active\n"
    monkeypatch.setattr(ops_watcher.subprocess, "run", lambda *a, **k: _P())
    assert ops_watcher.watcher_active(str(unit)) is True
    _P.stdout = "inactive\n"
    assert ops_watcher.watcher_active(str(unit)) is False


# ------------------------------------------------------------------ 5. no token left behind

def _public_safe_payload(**extra):
    return {"domains": ["orwell.example.org"], **extra}


def test_public_apply_writes_no_token_or_config_when_the_watcher_is_inactive(box, inactive, monkeypatch):
    monkeypatch.setenv("ORWELL_BIND_HOST", "127.0.0.1")
    r = _client().post("/api/admin/public-deployment/apply",
                       json=_public_safe_payload(tunnelToken="tok-secret"))
    assert r.status_code == 200 and r.json()["started"] is False
    ops = box / "ops"
    assert not (ops / "cloudflared-token").exists()
    assert not (ops / "public-deployment.json").exists()
    assert not (ops / "public-deployment-requested").exists()
    assert "tok-secret" not in r.text


def test_tls_apply_writes_no_token_or_config_when_the_watcher_is_inactive(box, inactive):
    r = _client().post("/api/admin/tls/apply", json={"domains": ["orwell.example.org"],
                                                     "dnsProvider": "cloudflare", "dnsApiToken": "tok-secret"})
    assert r.status_code == 200 and r.json()["started"] is False
    ops = box / "ops"
    assert not (ops / "tls-dns-token").exists() and not (ops / "tls.json").exists()
    assert not (ops / "tls-requested").exists()


def test_apply_with_an_active_watcher_still_writes_the_token_0600_then_the_flag(box, monkeypatch):
    monkeypatch.setenv("ORWELL_BIND_HOST", "127.0.0.1")
    r = _client().post("/api/admin/public-deployment/apply",
                       json=_public_safe_payload(tunnelToken="tok-secret"))
    assert r.status_code == 200 and r.json()["started"] is True
    tok = box / "ops" / "cloudflared-token"
    assert tok.read_text() == "tok-secret" and (tok.stat().st_mode & 0o777) == 0o600


# ------------------------------------------------------------------ 4. deploy-side flag handling

SERVICES = sorted((REPO / "deploy" / "systemd").glob("orwell-ops-*.service"))


def test_every_ops_service_removes_its_flag_with_a_removal_that_handles_a_directory():
    assert len(SERVICES) == 5
    for svc in SERVICES:
        text = svc.read_text()
        pre = [ln for ln in text.splitlines() if ln.startswith("ExecStartPre=") and "-requested" in ln]
        assert len(pre) == 1, svc.name
        assert re.fullmatch(r"ExecStartPre=/bin/rm -rf --one-file-system -- /opt/orwell/data/ops/[a-z-]+-requested",
                            pre[0]), svc.name
        assert "rm -f " not in "\n".join(ln for ln in text.splitlines() if ln.startswith("Exec")), svc.name


def test_rm_rf_removes_a_directory_planted_at_the_flag_path_without_following_symlinks(tmp_path):
    import subprocess
    flag = tmp_path / "update-requested"
    (flag / "sub").mkdir(parents=True)
    victim = tmp_path / "victim"
    victim.write_text("keep")
    (flag / "link").symlink_to(victim)
    assert subprocess.run(["rm", "-f", str(flag)], capture_output=True).returncode != 0   # the old removal wedged
    assert subprocess.run(["rm", "-rf", "--one-file-system", "--", str(flag)]).returncode == 0
    assert not flag.exists() and victim.read_text() == "keep"


def test_updater_clears_stale_destructive_flags_before_it_restarts_the_path_units():
    text = (REPO / "deploy" / "orwell-update.sh").read_text()
    guard = text.index("STALE-FLAG GUARD")
    assert "factory-reset-requested" in text[guard:guard + 900] and "update-reset-requested" in text[guard:guard + 900]
    assert "-mmin +2" in text[guard:guard + 900]
    assert guard < text.index("systemctl enable --now orwell-ops-factory-reset.path")
    assert guard < text.index("systemctl restart orwell-ops-update-reset.path")


def test_stale_flag_find_removes_only_old_destructive_flags(tmp_path):
    import subprocess, time
    ops = tmp_path / "data" / "ops"
    ops.mkdir(parents=True)
    old_t = time.time() - 600
    for name in ("factory-reset-requested", "update-reset-requested", "update-requested"):
        (ops / name).write_text("x")
        os.utime(ops / name, (old_t, old_t))
    (ops / "fresh").mkdir()
    (ops / "factory-reset-requested").unlink()
    (ops / "factory-reset-requested").mkdir()                    # a directory at the flag path, old
    os.utime(ops / "factory-reset-requested", (old_t, old_t))
    text = (REPO / "deploy" / "orwell-update.sh").read_text()
    m = re.search(r"(find \"\$\{APP_DIR\}/data/ops\".*?\|\| true)", text, re.S)
    cmd = m.group(1).replace('"${APP_DIR}"', str(tmp_path)).replace("${APP_DIR}", str(tmp_path)).replace("\\\n", " ")
    assert subprocess.run(["bash", "-c", cmd]).returncode == 0
    assert not (ops / "factory-reset-requested").exists() and not (ops / "update-reset-requested").exists()
    assert (ops / "update-requested").exists()                  # the non-destructive update flag is left


# ------------------------------------------------------------------ the guard helpers, directly

def test_origin_authority_normalises_default_ports_and_rejects_opaque_values():
    f = admin_guard._origin_authority
    assert f("https://Host.Example:443") == ("https", "host.example")
    assert f("http://10.0.0.5:7000") == ("http", "10.0.0.5:7000")
    assert f("http://[::1]:7000") == ("http", "[::1]:7000")
    for bad in ("null", "", "ftp://x", "http://", "https://x:notaport"):
        assert f(bad) is None

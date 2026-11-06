"""Admin one-click Update — pull → rebuild → refresh FE deps → restart both.

Proves:
  * the endpoint is admin-gated (403 without an admin session under AUTH_ENABLED=true, the shared
    require_admin contract — like test_g1_health_logs / test_0053_admin_transcripts);
  * with a genuine privileged path (ORWELL_UPDATE_DIRECT=1 / sudo) an admin call launches the FIXED
    script DETACHED (start_new_session=True, no shell, fixed argv) and returns {started: true};
  * with the G19b flag dir present it prefers the privilege-safe flag trigger (no subprocess);
  * the PRIVILEGE FIX (ops-run lane): with NO privileged path (no watcher unit, no sudo, no direct
    override) the endpoint FAILS LOUDLY — {started: false, error: …} + a FAILED ops-status file —
    instead of the old silent detached no-op (the unprivileged run aborts on the script's root-guard);
  * the command carries NO user input (fixed path, env-overridable only for tests/dev);
  * the Update button renders on the admin-gated status page (admin-only DOM by construction).

Name-agnostic: "admin"/"user" are ACCOUNT ROLES, never houseguests.
"""
import importlib
import os

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

aur = importlib.import_module("routes.admin_update_routes")
ahr = importlib.import_module("routes.admin_health_routes")


def _app():
    app = FastAPI()
    app.include_router(aur.setup_admin_update_routes())
    app.include_router(ahr.setup_admin_status_page())
    return app


def test_update_is_admin_gated(monkeypatch):
    # AUTH_ENABLED=true with no admin session → 403 (a non-admin cannot trigger an update).
    monkeypatch.setenv("AUTH_ENABLED", "true")
    client = TestClient(_app(), raise_server_exceptions=False)
    assert client.post("/api/admin/update").status_code == 403


def test_admin_update_runs_detached_and_returns_started(monkeypatch, tmp_path):
    # No real host path is touched: the script path is overridden and Popen is captured. The
    # detached path now requires an EXPLICIT privileged signal (ORWELL_UPDATE_DIRECT=1 — the dev
    # override) — without it the endpoint fails loudly (see test_admin_update_fails_loudly_...).
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setenv("DATA_DIR", str(tmp_path))                 # no data/ops → the detached path
    monkeypatch.setenv("ORWELL_UPDATE_DIRECT", "1")              # the genuine privileged-path override
    monkeypatch.delenv("ORWELL_UPDATE_SUDO", raising=False)
    monkeypatch.setenv("ORWELL_UPDATE_WATCHER_UNIT", str(tmp_path / "no-such.path"))  # no watcher
    stub = tmp_path / "fake-update.sh"
    stub.write_text("#!/bin/bash\necho updating\n")
    monkeypatch.setenv("ORWELL_UPDATE_SCRIPT", str(stub))
    monkeypatch.setenv("ORWELL_UPDATE_LOG", str(tmp_path / "update.log"))

    captured = {}

    class _FakeProc:
        pass

    def _fake_popen(argv, **kwargs):
        captured["argv"] = argv
        captured["kwargs"] = kwargs
        return _FakeProc()

    monkeypatch.setattr(aur.subprocess, "Popen", _fake_popen)

    client = TestClient(_app(), raise_server_exceptions=False)
    r = client.post("/api/admin/update")
    assert r.status_code == 200
    body = r.json()
    assert body["started"] is True
    assert body["via"] == "detached"

    # Fixed argv, no shell, no user input; detached into its own session so the self-restart
    # cannot kill it; output redirected to the log file.
    assert captured["argv"] == ["bash", str(stub)]
    assert captured["kwargs"].get("start_new_session") is True
    assert captured["kwargs"].get("shell") in (None, False)  # never shell=True
    # The run log got a timestamped header (we did not block on completion).
    assert (tmp_path / "update.log").exists()


def test_admin_update_sudo_wraps_argv(monkeypatch, tmp_path):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("ORWELL_UPDATE_SUDO", "1")
    monkeypatch.setenv("ORWELL_UPDATE_WATCHER_UNIT", str(tmp_path / "no-such.path"))  # no watcher → sudo path
    stub = tmp_path / "fake-update.sh"
    stub.write_text("#!/bin/bash\n")
    monkeypatch.setenv("ORWELL_UPDATE_SCRIPT", str(stub))
    monkeypatch.setenv("ORWELL_UPDATE_LOG", str(tmp_path / "update.log"))

    captured = {}
    monkeypatch.setattr(aur.subprocess, "Popen",
                        lambda argv, **kw: captured.update(argv=argv) or object())
    client = TestClient(_app(), raise_server_exceptions=False)
    r = client.post("/api/admin/update")
    assert r.status_code == 200 and r.json()["started"] is True
    assert captured["argv"] == ["sudo", "-n", "bash", str(stub)]


def test_admin_update_prefers_flag_trigger_when_installed(monkeypatch, tmp_path):
    # With the root-side G19b watcher UNIT installed, the privilege-safe trigger is used — NO
    # subprocess spawns. (The watcher unit, not a bare data/ops dir, proves the flag is consumed.)
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.delenv("ORWELL_UPDATE_DIRECT", raising=False)
    unit = tmp_path / "orwell-ops-update.path"
    unit.write_text("[Path]\n")
    monkeypatch.setenv("ORWELL_UPDATE_WATCHER_UNIT", str(unit))
    (tmp_path / "ops").mkdir()

    def _boom(*a, **k):  # the detached path must NOT be taken here
        raise AssertionError("subprocess.Popen must not run when the flag trigger is installed")

    monkeypatch.setattr(aur.subprocess, "Popen", _boom)
    client = TestClient(_app(), raise_server_exceptions=False)
    r = client.post("/api/admin/update")
    assert r.status_code == 200
    body = r.json()
    assert body["started"] is True and body["via"] == "flag-trigger"
    assert (tmp_path / "ops" / "update-requested").exists()


def test_admin_update_force_direct_overrides_flag(monkeypatch, tmp_path):
    # ORWELL_UPDATE_DIRECT=1 forces the detached path even when the flag dir exists.
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("ORWELL_UPDATE_DIRECT", "1")
    monkeypatch.delenv("ORWELL_UPDATE_SUDO", raising=False)
    (tmp_path / "ops").mkdir()
    stub = tmp_path / "fake-update.sh"
    stub.write_text("#!/bin/bash\n")
    monkeypatch.setenv("ORWELL_UPDATE_SCRIPT", str(stub))
    monkeypatch.setenv("ORWELL_UPDATE_LOG", str(tmp_path / "update.log"))

    captured = {}
    monkeypatch.setattr(aur.subprocess, "Popen",
                        lambda argv, **kw: captured.update(argv=argv, kw=kw) or object())
    client = TestClient(_app(), raise_server_exceptions=False)
    r = client.post("/api/admin/update")
    assert r.json()["via"] == "detached"
    assert captured["argv"] == ["bash", str(stub)]
    assert not (tmp_path / "ops" / "update-requested").exists()


def test_admin_update_fails_loudly_when_no_privileged_path(monkeypatch, tmp_path):
    # PRIVILEGE FIX (ops-run lane): no watcher unit, no data/ops, no sudo, no direct override →
    # the endpoint must NOT silently "start" a doomed unprivileged run. It returns started:false
    # with an error AND writes a FAILED ops-status file so the status page surfaces it.
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("ORWELL_UPDATE_WATCHER_UNIT", str(tmp_path / "no-such.path"))
    monkeypatch.delenv("ORWELL_UPDATE_SUDO", raising=False)
    monkeypatch.delenv("ORWELL_UPDATE_DIRECT", raising=False)
    (tmp_path / "ops").mkdir()  # data/ops present (the installer makes it) must NOT fake "installed"

    def _boom(*a, **k):
        raise AssertionError("no subprocess may run when there is no privileged path")

    monkeypatch.setattr(aur.subprocess, "Popen", _boom)
    client = TestClient(_app(), raise_server_exceptions=False)
    r = client.post("/api/admin/update")
    assert r.status_code == 200
    body = r.json()
    assert body["started"] is False
    assert body["via"] == "none"
    assert "no privileged path" in body["error"]
    # The failure is published through the ops-progress channel the status page polls.
    import json
    status = json.loads((tmp_path / "ops" / "update-status.json").read_text())
    assert status["ok"] is False and status["running"] is False
    assert status["message"].startswith("FAILED:")


def test_admin_update_uses_flag_when_watcher_unit_present(monkeypatch, tmp_path):
    # The watcher UNIT FILE (not just data/ops) is the true privileged-door signal — present → the
    # endpoint creates data/ops itself and drops the flag (no subprocess).
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    unit = tmp_path / "orwell-ops-update.path"
    unit.write_text("[Path]\n")
    monkeypatch.setenv("ORWELL_UPDATE_WATCHER_UNIT", str(unit))
    monkeypatch.delenv("ORWELL_UPDATE_DIRECT", raising=False)

    def _boom(*a, **k):
        raise AssertionError("flag trigger must be preferred when the watcher unit is installed")

    monkeypatch.setattr(aur.subprocess, "Popen", _boom)
    client = TestClient(_app(), raise_server_exceptions=False)
    r = client.post("/api/admin/update")
    assert r.json()["via"] == "flag-trigger"
    assert (tmp_path / "ops").is_dir()  # the endpoint created data/ops itself
    assert (tmp_path / "ops" / "update-requested").exists()


def test_default_script_path_is_fixed():
    # The default is the fixed deploy path; overridable only via env for tests/dev.
    assert aur.DEFAULT_UPDATE_SCRIPT == "/opt/orwell/deploy/orwell-update.sh"
    assert aur.DEFAULT_UPDATE_LOG == "/opt/orwell/data/update.log"


def test_status_page_carries_the_update_button(monkeypatch):
    # The button renders on the admin-gated status page; non-admin can't reach the page at all.
    monkeypatch.setenv("AUTH_ENABLED", "true")
    gated = TestClient(_app(), raise_server_exceptions=False)
    assert gated.get("/admin/status").status_code == 403

    monkeypatch.setenv("AUTH_ENABLED", "false")
    client = TestClient(_app(), raise_server_exceptions=False)
    body = client.get("/admin/status").text
    assert 'id="update-orwell"' in body
    assert "Update Orwell (pull + rebuild + restart)" in body
    assert "/api/admin/update" in body


def test_status_page_persists_update_awareness_across_the_restart(monkeypatch):
    # The Update button restarts both tiers — including this page's host. The page must persist the
    # "updating… reconnecting" awareness in localStorage so a reload mid-bounce RESUMES the soft state
    # (and recovers when the tiers answer) instead of showing a false hard "Health check failed".
    monkeypatch.setenv("AUTH_ENABLED", "false")
    client = TestClient(_app(), raise_server_exceptions=False)
    body = client.get("/admin/status").text
    # The persisted flag is set when an update begins and cleared on a healthy poll / a no-start.
    assert "orwell-admin-updating" in body
    assert "localStorage.setItem" in body and "localStorage.removeItem" in body
    assert "markUpdating()" in body and "clearUpdating()" in body
    # On a fresh load DURING a restart, the reconnect loop is resumed rather than erroring out.
    assert "if (isUpdating())" in body and "waitForBack()" in body
    # A known update turns a failed health probe into a SOFT reconnecting line, not a hard outage.
    assert "reconnecting" in body.lower()


def test_routes_wired_into_app_py():
    # The router is registered in app.py (the surface is actually mounted, not just defined).
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    app_py = open(os.path.join(base, "app.py"), encoding="utf-8").read()
    assert "setup_admin_update_routes" in app_py


def _force_setup(monkeypatch, tmp_path):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.delenv("ORWELL_UPDATE_DIRECT", raising=False)
    unit = tmp_path / "orwell-ops-update.path"
    unit.write_text("[Path]\n")
    monkeypatch.setenv("ORWELL_UPDATE_WATCHER_UNIT", str(unit))
    (tmp_path / "ops").mkdir()
    return TestClient(_app(), raise_server_exceptions=False)


def _status(tmp_path, running, age_s=0):
    import datetime as dt, json
    ts = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=age_s)).strftime("%Y-%m-%dT%H:%M:%SZ")
    (tmp_path / "ops" / "update-status.json").write_text(json.dumps({"running": running, "ts": ts}))


def test_force_with_no_active_update_queues_one_and_sets_the_force_flag(monkeypatch, tmp_path):
    client = _force_setup(monkeypatch, tmp_path)
    r = client.post("/api/admin/update/force").json()
    assert r["started"] is True and r["queued"] is True
    assert (tmp_path / "ops" / "update-requested").exists() and (tmp_path / "ops" / "update-force-requested").exists()


def test_force_while_an_update_is_running_writes_only_the_force_flag(monkeypatch, tmp_path):
    client = _force_setup(monkeypatch, tmp_path)
    _status(tmp_path, running=True, age_s=30)
    r = client.post("/api/admin/update/force").json()
    assert r["started"] is True and r["queued"] is False
    assert (tmp_path / "ops" / "update-force-requested").exists()
    assert not (tmp_path / "ops" / "update-requested").exists()    # no second update + restart


def test_force_with_a_stale_running_status_still_queues(monkeypatch, tmp_path):
    client = _force_setup(monkeypatch, tmp_path)
    _status(tmp_path, running=True, age_s=7200)     # a crashed run's leftover
    assert client.post("/api/admin/update/force").json()["queued"] is True


def test_force_flag_is_removed_when_queueing_fails(monkeypatch, tmp_path):
    client = _force_setup(monkeypatch, tmp_path)
    def _fail():
        raise OSError("disk full")
    monkeypatch.setattr(aur, "_trigger_via_flag", _fail)
    r = client.post("/api/admin/update/force").json()
    assert r["started"] is False
    assert not (tmp_path / "ops" / "update-force-requested").exists()

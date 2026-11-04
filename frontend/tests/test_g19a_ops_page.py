"""Lane G19a — ops from the status page (allowlisted runs + the update trigger).

The web tier never chooses what executes: fixed ids map to fixed argv, the
update writes a FLAG only (content ignored; the root-side G19b path unit runs
the real script), and everything is admin-gated read-or-trigger-only.
"""
import importlib
import os
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ahr = importlib.import_module("routes.admin_health_routes")


def _app():
    app = FastAPI()
    app.include_router(ahr.setup_admin_health_routes())
    app.include_router(ahr.setup_admin_status_page())
    return app


def test_ops_listing_is_admin_gated(monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "true")
    client = TestClient(_app(), raise_server_exceptions=False)
    assert client.get("/api/admin/ops").status_code == 403
    assert client.post("/api/admin/ops/run/panel").status_code == 403
    assert client.post("/api/admin/ops/trigger-update").status_code == 403


def test_ops_run_refuses_unknown_ids(monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    client = TestClient(_app(), raise_server_exceptions=False)
    for evil in ("rm-rf", "../orwell-update.sh", "panel;id", "factory-reset"):
        assert client.post(f"/api/admin/ops/run/{evil}").status_code == 404, evil


def test_ops_allowlist_is_read_only_scripts_with_fixed_argv():
    # The allowlist itself is the security boundary: only the two read-only
    # entries exist, argv is fixed, and the update is NOT a script entry here.
    assert set(ahr._OPS_SCRIPTS) == {"panel", "doctor-status"}
    assert ahr._OPS_SCRIPTS["doctor-status"][2] == ["--status"]
    assert ahr._OPS_SCRIPTS["panel"][2] == []


def test_ops_run_streams_to_its_log(monkeypatch, tmp_path):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    stub = tmp_path / "stub.sh"
    stub.write_text("#!/bin/bash\necho line-one\necho line-two\n")
    monkeypatch.setattr(ahr, "_ops_script_path", lambda script: str(stub))
    client = TestClient(_app(), raise_server_exceptions=False)
    r = client.post("/api/admin/ops/run/panel")
    assert r.status_code == 200 and r.json()["started"] is True
    log = tmp_path / "ops-panel.log"
    for _ in range(40):
        if log.exists() and "[ops] exit 0" in log.read_text():
            break
        time.sleep(0.1)
    text = log.read_text()
    assert "line-one" in text and "line-two" in text and "[ops] exit 0" in text


def test_ops_update_trigger_requires_install_then_writes_flag(monkeypatch, tmp_path):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    client = TestClient(_app(), raise_server_exceptions=False)
    unit = tmp_path / "orwell-ops-update.path"
    monkeypatch.setenv("ORWELL_UPDATE_WATCHER_UNIT", str(unit))
    # not installed: no watcher unit → honest refusal, nothing written
    r = client.post("/api/admin/ops/trigger-update")
    assert r.json()["triggered"] is False and r.json()["installed"] is False
    # a bare data/ops dir (created on every box) is NOT proof the flag will be consumed
    (tmp_path / "ops").mkdir()
    r = client.post("/api/admin/ops/trigger-update")
    assert r.json()["triggered"] is False
    assert not (tmp_path / "ops" / "update-requested").exists()
    # installed + active: the flag is written; content is a timestamp (ignored by the unit)
    unit.write_text("[Path]\n")
    r2 = client.post("/api/admin/ops/trigger-update")
    assert r2.json()["triggered"] is True
    assert (tmp_path / "ops" / "update-requested").exists()


def test_ops_page_carries_the_section(monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    client = TestClient(_app(), raise_server_exceptions=False)
    body = client.get("/admin/status").text
    assert "OPS" in body and 'id="opsrow"' in body
    assert "/api/admin/ops/run/" in body and "trigger-update" in body
    # The OPS SCRIPT row still only runs read-only scripts + the update trigger; the destructive
    # Factory Reset (OOBE) lives in the top controls and goes through its own root-side trigger.
    assert "Factory Reset (OOBE)" in body
    assert "goes through its own root-side trigger" in body

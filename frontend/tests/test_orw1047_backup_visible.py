"""ORW-1047: the scheduled backup must never fail silently.

Prod's unit died 97 times with 226/NAMESPACE (a path directive naming a missing directory fails every
command at namespace setup) and later with tar exit 1 ("file changed as we read it"); nothing alerted.
"""

import importlib
import json
import os
import re
import shutil
import subprocess
import time

import pytest

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEPLOY = os.path.join(REPO, "deploy")
UNIT = os.path.join(DEPLOY, "systemd", "orwell-backup.service")
ahr = importlib.import_module("routes.admin_health_routes")

NAMESPACE_PATH_KEYS = ("ReadWritePaths", "ReadOnlyPaths", "InaccessiblePaths", "BindPaths", "BindReadOnlyPaths", "TemporaryFileSystem")


def _unit_lines():
    with open(UNIT, encoding="utf-8") as f:
        return [ln.strip() for ln in f if ln.strip() and not ln.lstrip().startswith("#")]


def test_unit_renders_with_every_namespace_path_optional_and_created_first():
    """Any path a mount namespace needs must be optional ('-') or created by a '+' ExecStartPre."""
    lines = _unit_lines()
    pre = " ".join(ln for ln in lines if ln.startswith("ExecStartPre=+"))
    seen = 0
    for ln in lines:
        key, _, val = ln.partition("=")
        if key not in NAMESPACE_PATH_KEYS:
            continue
        for path in val.split():
            seen += 1
            assert path.startswith("-") or path in pre, f"{ln}: a missing path here fails the unit with 226/NAMESPACE"
    assert seen, "the unit names its writable path"


def test_unit_has_no_directive_that_needs_more_than_a_plain_mount_namespace():
    keys = {ln.partition("=")[0] for ln in _unit_lines()}
    # Directives that need privileges an unprivileged LXC does not grant (device nodes, user namespaces, cgroup delegation).
    assert not keys & {"PrivateDevices", "PrivateUsers", "PrivateNetwork", "MountAPIVFS", "DynamicUser", "RootDirectory", "RootImage", "BindPaths"}


@pytest.mark.skipif(shutil.which("systemd-analyze") is None, reason="systemd-analyze not installed")
def test_systemd_analyze_verify_accepts_the_unit(tmp_path):
    d = tmp_path / "units"
    d.mkdir()
    shutil.copy(UNIT, d / "orwell-backup.service")
    r = subprocess.run(["systemd-analyze", "verify", str(d / "orwell-backup.service")], capture_output=True, text=True)
    bad = [ln for ln in (r.stdout + r.stderr).splitlines()
           if re.search(r"Unknown (key|section)|Invalid|Failed to parse|Unknown lvalue|Unit .* has a bad", ln)]
    assert not bad, "\n".join(bad)


# ---------------------------------------------------------------- the script

def _run_backup(app, dest, extra_env=None, path=None):
    env = {**os.environ, "APP_DIR": str(app), **(extra_env or {})}
    if path:
        env["PATH"] = path
    return subprocess.run(["bash", os.path.join(DEPLOY, "orwell-backup.sh"), str(dest)], env=env, capture_output=True, text=True)


def _app(tmp_path):
    app = tmp_path / "app"
    (app / "data").mkdir(parents=True)
    (app / "data" / "marker").write_text("x")
    return app


def test_success_records_an_ok_status(tmp_path):
    app, dest = _app(tmp_path), tmp_path / "dest"
    r = _run_backup(app, dest)
    assert r.returncode == 0, r.stderr
    rec = json.loads((dest / ".backup-status.json").read_text())
    assert rec["status"] == "ok" and rec["finishedAt"] >= rec["startedAt"] and rec["archive"].endswith(".tar.gz")


def _fake_tar(tmp_path, rc, write_archive=True):
    """A tar wrapper that runs the real tar and then exits with ``rc`` (1 = a file changed while read)."""
    real = shutil.which("tar")
    bindir = tmp_path / "bin"
    bindir.mkdir()
    t = bindir / "tar"
    t.write_text(f'#!/bin/bash\nif [[ "$1" == -czf ]]; then {real} "$@"; ' + ('' if write_archive else 'rm -f "$2"; ') + f'echo "tar: data: file changed as we read it" >&2; exit {rc}; fi\nexec {real} "$@"\n')
    t.chmod(0o755)
    return str(bindir) + os.pathsep + os.environ["PATH"]


def test_tar_file_changed_is_not_fatal_but_is_recorded(tmp_path):
    app, dest = _app(tmp_path), tmp_path / "dest"
    r = _run_backup(app, dest, path=_fake_tar(tmp_path, 1))
    assert r.returncode == 0, r.stderr
    assert len(list(dest.glob("orwell-backup-*.tar.gz"))) == 1
    rec = json.loads((dest / ".backup-status.json").read_text())
    assert rec["status"] == "ok" and "changed" in rec["warning"]


def test_tar_exit_1_with_an_unreadable_archive_fails(tmp_path):
    app, dest = _app(tmp_path), tmp_path / "dest"
    r = _run_backup(app, dest, path=_fake_tar(tmp_path, 1, write_archive=False))
    assert r.returncode != 0
    assert json.loads((dest / ".backup-status.json").read_text())["status"] == "failed"


def test_tar_hard_failure_fails_and_is_recorded(tmp_path):
    app, dest = _app(tmp_path), tmp_path / "dest"
    r = _run_backup(app, dest, path=_fake_tar(tmp_path, 2))
    assert r.returncode == 2 and "ERROR" in r.stderr
    rec = json.loads((dest / ".backup-status.json").read_text())
    assert rec["status"] == "failed" and not list(dest.glob("orwell-backup-*.tar.gz"))


def test_a_live_database_write_during_the_run_never_fails_it(tmp_path):
    """The database is archived from an online-backup snapshot, so a WAL database that is mid-write backs up cleanly."""
    import sqlite3
    app, dest = _app(tmp_path), tmp_path / "dest"
    (app / "frontend" / "data").mkdir(parents=True)
    db = sqlite3.connect(app / "frontend" / "data" / "app.db")
    db.execute("pragma journal_mode=wal")
    db.execute("create table t(x)")
    db.execute("insert into t values (1)")
    db.commit()
    db.execute("insert into t values (2)")  # an open write transaction while the backup runs
    r = _run_backup(app, dest)
    db.commit()
    db.close()
    assert r.returncode == 0, r.stderr
    assert json.loads((dest / ".backup-status.json").read_text())["status"] == "ok"


# ---------------------------------------------------------------- the doctor

def _doctor_check(app, extra_env=None):
    """Run only backup_status_check out of the doctor script (sourced function body, no live services)."""
    src = open(os.path.join(DEPLOY, "orwell-doctor.sh"), encoding="utf-8").read()
    a = src.index("BACKUP_MAX_AGE_H=")
    b = src.index("# DEPLOY-17: the deploy PAT")
    prog = ('fails=0; SEASON_HOLD_FAILS=0; pass(){ echo "ok $*"; }; fail(){ echo "FAIL $*"; fails=$((fails+1)); }\n'
            + src[a:b] + '\nbackup_status_check; echo "fails=$fails hold=$SEASON_HOLD_FAILS"\n')
    return subprocess.run(["bash", "-c", prog], env={**os.environ, "APP_DIR": str(app), **(extra_env or {})}, capture_output=True, text=True).stdout


def _record(app, status, age_s, message="x"):
    d = app / "backups"
    d.mkdir(parents=True, exist_ok=True)
    now = int(time.time())
    (d / ".backup-status.json").write_text(json.dumps({"status": status, "startedAt": now - age_s - 5, "finishedAt": now - age_s, "archive": "a.tar.gz", "message": message, "warning": ""}))


def test_doctor_passes_a_fresh_ok_record(tmp_path):
    _record(tmp_path, "ok", 3600)
    out = _doctor_check(tmp_path)
    assert out.startswith("ok backup: last run ok 1 h ago") and "fails=0" in out


def test_doctor_fails_when_older_than_26_hours(tmp_path):
    _record(tmp_path, "ok", 27 * 3600)
    out = _doctor_check(tmp_path)
    assert "FAIL backup: last good backup is 27 h old" in out and "fails=1 hold=1" in out


def test_doctor_fails_when_the_last_run_failed_even_if_recent(tmp_path):
    _record(tmp_path, "failed", 600, "backup failed (exit 2)")
    out = _doctor_check(tmp_path)
    assert "FAIL backup: the last run FAILED" in out and "exit 2" in out


def test_doctor_fails_with_no_record(tmp_path):
    (tmp_path / "backups").mkdir()
    assert "FAIL backup: no backup has ever run" in _doctor_check(tmp_path)


# ---------------------------------------------------------------- the admin health page

def test_backup_section_states(tmp_path, monkeypatch):
    monkeypatch.setenv("ORWELL_BACKUP_DIR", str(tmp_path / "backups"))
    assert ahr._backup_section()["state"] == "none"
    _record(tmp_path, "ok", 100)
    assert ahr._backup_section()["state"] == "ok"
    _record(tmp_path, "ok", 27 * 3600)
    assert ahr._backup_section()["state"] == "stale"
    _record(tmp_path, "failed", 100)
    assert ahr._backup_section()["state"] == "failed"


def test_failed_or_stale_backup_raises_exactly_one_alarm():
    for state in ("failed", "stale"):
        alarms = ahr._compute_alarms({}, backup={"state": state, "ageS": 7200, "message": "backup failed (exit 2)"})
        mine = [a for a in alarms if a["code"] == "backup-failing"]
        assert len(mine) == 1 and mine[0]["severity"] == "red"
    for state in ("ok", "none"):
        assert not [a for a in ahr._compute_alarms({}, backup={"state": state, "ageS": 5}) if a["code"] == "backup-failing"]
    assert not [a for a in ahr._compute_alarms({}) if a["code"] == "backup-failing"]

"""The nightly backup must actually succeed on a box whose backups/ dir does not exist yet.

Two independent bugs made ``orwell-backup.service`` report failure (found on dev, 2026-11-03):

  1. ``ReadWritePaths=/opt/orwell/backups`` on a MISSING path fails every command in the unit at
     namespace setup — exit 226/NAMESPACE — before ``ExecStart`` runs. Boxes reconciled only by
     ``orwell-update.sh`` never had the directory (only ``orwell-install.sh`` created it).
  2. ``orwell-backup.sh`` ended with ``[[ pruned -gt 0 ]] && echo``; with nothing to prune (the normal case)
     that list is false and, as the last command, made a fully successful backup exit 1.
"""

import os
import subprocess

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEPLOY = os.path.join(REPO, "deploy")


def _read(*parts):
    with open(os.path.join(DEPLOY, *parts), encoding="utf-8") as f:
        return f.read()


def test_unit_tolerates_a_missing_backups_dir_and_creates_it():
    unit = _read("systemd", "orwell-backup.service")
    lines = [ln.strip() for ln in unit.splitlines() if not ln.lstrip().startswith("#")]
    assert "ReadWritePaths=-/opt/orwell/backups" in lines, "a missing dir must not be fatal at namespace setup"
    pre = [ln for ln in lines if ln.startswith("ExecStartPre=")]
    assert pre and pre[0].startswith("ExecStartPre=+"), "the dir is created outside the sandbox (+)"
    assert "/opt/orwell/backups" in pre[0] and "-o orwell" in pre[0]


def test_updater_creates_the_backups_dir_before_installing_the_unit():
    upd = _read("orwell-update.sh")
    mk = upd.index('mkdir -p "${APP_DIR}/backups"')
    inst = upd.index("/etc/systemd/system/orwell-backup.service")
    assert mk < inst


def test_script_exits_zero_when_nothing_is_pruned(tmp_path):
    app = tmp_path / "app"
    (app / "data").mkdir(parents=True)
    (app / "data" / "marker").write_text("x")
    dest = tmp_path / "dest"  # does not exist yet: the script creates it
    r = subprocess.run(
        ["bash", os.path.join(DEPLOY, "orwell-backup.sh"), str(dest)],
        env={**os.environ, "APP_DIR": str(app)},
        capture_output=True, text=True,
    )
    assert r.returncode == 0, r.stderr
    assert len(list(dest.glob("orwell-backup-*.tar.gz"))) == 1

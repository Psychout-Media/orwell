"""ORW-1048: every updater run leaves one complete, timestamped record in ops-update.log (result, from, to, deferral, revert)."""
import re
import shutil
import subprocess
from pathlib import Path

import pytest

DEPLOY = Path(__file__).resolve().parents[2] / "deploy"
SRC = (DEPLOY / "orwell-update.sh").read_text()
needs_bash = pytest.mark.skipif(shutil.which("bash") is None, reason="bash required")


def _funcs() -> str:
    start = SRC.index("RUN_T0=")
    end = SRC.index("# The helper sourced above may be the OLDER")
    return SRC[start:end]


def _run(tmp_path, body, env_extra=""):
    app = tmp_path / "app"
    (app / "data").mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q", str(app)], check=True)
    subprocess.run(["git", "-C", str(app), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"], check=True)
    script = f"APP_DIR='{app}'; REF=''; {env_extra} {_funcs()} {body}"
    subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=30)
    return (app / "data" / "ops-update.log").read_text() if (app / "data" / "ops-update.log").exists() else ""


@needs_bash
def test_success_run_record(tmp_path):
    log = _run(tmp_path, "ops_run_record 0")
    m = re.search(r"run record \S+: result=ok exit=0 from=(\w+) to=(\w+) requested_ref=branch-tip deferral=none deferred_seconds=0 revert=none", log)
    assert m and m.group(1) == m.group(2) and m.group(1) != "unknown"


@needs_bash
def test_failed_run_with_revert_and_deferral_is_recorded(tmp_path):
    log = _run(tmp_path, "RUN_REVERT=reverted; RUN_DEFER_S=120; UPDATE_WAIT_DEFERRED=1; ops_run_record 1")
    assert "result=failed exit=1" in log and "revert=reverted" in log and "deferral=waited deferred_seconds=120" in log


@needs_bash
def test_cancelled_and_overdue_are_distinct(tmp_path):
    assert "result=cancelled exit=0" in _run(tmp_path, "RUN_RESULT=cancelled; ops_run_record 0")
    assert "deferral=overdue-waited" in _run(tmp_path / "b", "UPDATE_WAIT_OVERDUE=1; ops_run_record 0")


@needs_bash
def test_record_written_once_and_by_exit_trap_when_killed(tmp_path):
    log = _run(tmp_path, "trap ops_run_record_exit EXIT; ops_run_record 0; kill -TERM $$; sleep 2")
    assert log.count("run record") == 1


@needs_bash
def test_exit_trap_records_a_run_that_dies(tmp_path):
    log = _run(tmp_path, "trap ops_run_record_exit EXIT; exit 7")
    assert "result=failed exit=7" in log


def test_wired_into_every_exit_path():
    assert "ops_run_tee_output" in SRC and "trap ops_run_record_exit EXIT" in SRC
    assert re.search(r"ops_run_record \"\$rrc\"", SRC) and "RUN_REVERT=\"reverted\"" in SRC

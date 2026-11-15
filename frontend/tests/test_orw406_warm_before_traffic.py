"""ORW-406 slice 3 - the updater waits for the new build to warm, and never fails the update on a timeout."""
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
LIB = ROOT / "deploy" / "orwell-live-game.sh"
UPDATE = (ROOT / "deploy" / "orwell-update.sh").read_text()
needs_bash = pytest.mark.skipif(shutil.which("bash") is None, reason="bash required")

ENG, FE = "http://engine/health", "http://fe/health"


def run(script, env=None):
    full = dict(os.environ)
    full.update(env or {})
    r = subprocess.run(["bash", "-c", f"set -euo pipefail; . '{LIB}'; {script}"],
                       capture_output=True, text=True, timeout=60, env=full)
    assert r.returncode == 0, r.stderr
    return r.stdout


# The probe is a stub: the engine reports warmed:false for the first N polls, then true; the front end is up.
HARNESS = """
NOW=1000; SLEEPS=0; CNT='@@LOG@@.cnt'; echo 0 > "$CNT"
_update_defer_now() { echo $NOW; }
_update_defer_sleep() { SLEEPS=$((SLEEPS+1)); NOW=$((NOW+$1)); }
_update_probe() {
  case "$1" in
    @@ENG@@) P=$(( $(cat "$CNT") + 1 )); echo $P > "$CNT"; if (( P > @@N@@ )); then echo '{"ok":true,"warmed":true,"warmMs":4200}'; else echo '{"ok":true,"warmed":false,"warmMs":null}'; fi ;;
    @@FE@@) echo '{"engine":true}' ;;
  esac
}
update_wait_for_warm '@@ENG@@' '@@FE@@' '@@LOG@@'
echo "rc=$? SLEEPS=$SLEEPS"
"""


def harness(n, log):
    return HARNESS.replace("@@ENG@@", ENG).replace("@@FE@@", FE).replace("@@N@@", str(n)).replace("@@LOG@@", str(log))


@needs_bash
def test_waits_for_warmed_then_logs_duration(tmp_path):
    log = tmp_path / "ops-update.log"
    out = run(harness(3, log))
    assert "rc=0 SLEEPS=3" in out
    assert "warm-up complete" in out and "engine reported 4200ms" in out
    assert "warm-up complete" in log.read_text()


@needs_bash
def test_timeout_logs_and_proceeds(tmp_path):
    log = tmp_path / "ops-update.log"
    out = run(harness(10**6, log), env={"ORWELL_UPDATE_WARM_WAIT_SECONDS": "10"})
    assert "rc=0" in out
    assert "warm-up not confirmed after 10s" in out and "continuing" in out
    assert "warm-up not confirmed" in log.read_text()


@needs_bash
def test_old_engine_without_warmed_field_counts_as_warm(tmp_path):
    script = harness(0, tmp_path / "l").replace('"warmed":true,"warmMs":4200', '"uptime":1').replace('"warmed":false,"warmMs":null', '"uptime":1')
    assert "rc=0 SLEEPS=0" in run(script)


def test_updater_wiring():
    i = UPDATE.index('systemctl restart "$ENGINE_SVC" "$FRONTEND_SVC"\n    fi')
    blk = UPDATE[i:UPDATE.index("update complete (")]
    assert "update_wait_for_warm" in blk and "/api/orwell/health" in blk and "/health" in blk
    call = blk[blk.index("update_wait_for_warm "):blk.index("\n    fi", blk.index("update_wait_for_warm "))]  # the call itself, not an unrelated `|| true` earlier in the block
    assert call.rstrip().endswith("|| true"), call  # a warm-up problem can never fail the update
    assert blk.index("update_restarted_sha_write") < blk.index("update_wait_for_warm") < blk.index("ops_progress_done")


@needs_bash
def test_line_is_written_once_when_stdout_is_the_log(tmp_path):
    # The ops unit appends stdout INTO the ops log (>>); the helper must not append the same line a second time.
    log = tmp_path / "ops-update.log"
    script = harness(0, log)
    r = subprocess.run(["bash", "-c", f"set -euo pipefail; . '{LIB}'; {script}"], stdout=open(log, "a"),
                       stderr=subprocess.PIPE, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    assert log.read_text().count("warm-up complete") == 1, log.read_text()


@needs_bash
@pytest.mark.parametrize("allowed,host", [("", ""), ("*", ""), ("game.example.com,www.example.com", "game.example.com"),
                                          ("*.example.com", "example.com"), ('"game.example.com"', "game.example.com")])
def test_probe_host_comes_from_allowed_hosts(allowed, host):
    assert run(f"update_probe_host '{allowed}'") == host


@needs_bash
def test_front_end_probe_sends_the_pinned_host_header(tmp_path):
    # With ALLOWED_HOSTS pinned, Host: 127.0.0.1 is rejected and the front end never looks ready: the probe must send the allowed Host.
    bindir = tmp_path / "bin"
    bindir.mkdir()
    seen = tmp_path / "seen"
    (bindir / "curl").write_text(f'#!/bin/bash\necho "$@" >> "{seen}"\necho \'{{"ok":true,"warmed":true,"engine":true}}\'\n')
    (bindir / "curl").chmod(0o755)
    out = run("update_wait_for_warm 'http://127.0.0.1:1/health' 'http://127.0.0.1:2/api/orwell/health' '' 'game.example.com'",
              env={"PATH": f"{bindir}:{os.environ['PATH']}"})
    assert "warm-up complete" in out
    lines = seen.read_text().splitlines()
    assert any("Host: game.example.com" in l and ":2/" in l for l in lines)
    assert not any("Host:" in l and ":1/" in l for l in lines)


def test_both_callers_pass_the_allowed_host():
    oobe = (ROOT / "deploy" / "orwell-oobe-reset.sh").read_text()
    assert "update_probe_host" in oobe and "update_probe_host" in UPDATE


def test_reset_waits_for_warm_only_when_a_service_was_started():
    oobe = (ROOT / "deploy" / "orwell-oobe-reset.sh").read_text()
    i = oobe.index("type update_wait_for_warm")
    cond = oobe[oobe.rindex("\n", 0, i):i]
    assert "${#STARTED[@]} -gt 0" in cond

"""ORW-461 (updater half): the update holds NEW turns before it waits for the in-flight ones, lifts the hold after the restart and warm-up, and on any failure. Sandboxed
only: the real helper and the updater's own wait block are run against a temp directory with stubbed sleeps; the update script is never run against an install."""
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
LIB = ROOT / "deploy" / "orwell-live-game.sh"
UPDATE = (ROOT / "deploy" / "orwell-update.sh").read_text()
needs_bash = pytest.mark.skipif(shutil.which("bash") is None, reason="bash required")


def _bash(script, env=None):
    return subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=60, env={**os.environ, **(env or {})})


@needs_bash
def test_hold_begin_writes_a_future_stamp_the_front_end_user_can_read_and_end_removes_it(tmp_path):
    r = _bash(f'. "{LIB}"; _update_defer_now() {{ echo 5000; }}; update_turn_hold_begin "{tmp_path}" 240; cat "{tmp_path}/turns-hold"; stat -c %a "{tmp_path}/turns-hold"; '
              f'update_turn_hold_end "{tmp_path}"; ls -A "{tmp_path}"')
    assert r.returncode == 0, r.stderr
    lines = r.stdout.splitlines()
    assert "until=5240" in lines and "644" in lines
    assert lines[-1] != "turns-hold" and not (tmp_path / "turns-hold").exists()
    assert not list(tmp_path.glob(".turns-hold.*")), "no temp file left behind"


@needs_bash
def test_hold_begin_never_creates_the_directory_and_ignores_a_bad_length(tmp_path):
    missing = tmp_path / "nope"
    assert _bash(f'. "{LIB}"; update_turn_hold_begin "{missing}" 240').returncode == 0 and not missing.exists()
    r = _bash(f'. "{LIB}"; _update_defer_now() {{ echo 100; }}; update_turn_hold_begin "{tmp_path}" abc; cat "{tmp_path}/turns-hold"')
    assert "until=340" in r.stdout, "a non-numeric length falls back to 240 s"


def _wait_block():
    i = UPDATE.index("if type update_wait_for_no_turn")
    return UPDATE[i:UPDATE.index('ops_progress_step 4 "restarting services"', i)]


def _run_block(tmp_path, helper_prelude, force_now=0):
    (tmp_path / "turns-in-flight").write_text("1\n")
    script = f"""set -euo pipefail
{helper_prelude}
FORCE_NOW={force_now}; ENV_FILE=/dev/null; APP_DIR='{tmp_path}'; export ORWELL_INFLIGHT_DIR='{tmp_path}'
{_wait_block()}
echo "AFTER-WAIT hold=$([ -f '{tmp_path}/turns-hold' ] && echo present || echo absent)"
"""
    return _bash(script, {"ORWELL_INFLIGHT_DIR": str(tmp_path)})


@needs_bash
def test_new_turns_are_held_while_the_updater_waits_for_the_one_in_flight(tmp_path):
    # the real helper; time and sleep stubbed: the turn in flight finishes during the 2nd nap, and the hold is in force at every nap
    prelude = f""". "{LIB}"
NOW=1000; N=0
_update_defer_now() {{ echo $NOW; }}
_update_defer_sleep() {{ N=$((N+1)); NOW=$((NOW+$1)); [ -f '{tmp_path}/turns-hold' ] && echo "NAP$N hold=present" || echo "NAP$N hold=ABSENT"; [ $N -ge 2 ] && echo 0 > '{tmp_path}/turns-in-flight' || true; }}
"""
    r = _run_block(tmp_path, prelude)
    assert r.returncode == 0, r.stderr
    naps = [l for l in r.stdout.splitlines() if l.startswith("NAP")]
    assert naps and all(l.endswith("hold=present") for l in naps), r.stdout
    assert "waiting for it to finish" in r.stdout
    assert "AFTER-WAIT hold=present" in r.stdout, "the hold stays in force through the restart that follows the wait"
    assert "holding new turns" in r.stdout


@needs_bash
def test_force_now_does_not_hold_and_an_old_helper_without_the_hold_still_works(tmp_path):
    prelude = f""". "{LIB}"
_update_defer_now() {{ echo 1000; }}
"""
    r = _run_block(tmp_path, prelude, force_now=1)
    assert r.returncode == 0 and "AFTER-WAIT hold=absent" in r.stdout, r.stdout + r.stderr   # the emergency path does not wait, so it does not hold
    # the installed helper is the OLDER one (no hold functions): the new updater must not print "command not found" or fail
    (tmp_path / "turns-in-flight").write_text("0\n")
    old = "update_wait_for_no_turn() { echo OLD-WAIT; }"
    r = _run_block(tmp_path, old)
    assert r.returncode == 0 and "OLD-WAIT" in r.stdout and "command not found" not in r.stderr, r.stdout + r.stderr
    assert "AFTER-WAIT hold=absent" in r.stdout


def test_the_hold_wraps_the_wait_the_restart_and_the_warm_up_and_every_exit_lifts_it():
    base = UPDATE.index("RESTART_SCOPE=both")
    blk = UPDATE[base:UPDATE.index("update complete (", base)]
    begin = blk.index('update_turn_hold_begin "$__HOLD_DIR"')
    wait = blk.index('update_wait_for_no_turn "${INFLIGHT_DIR:-')
    restart = blk.index('systemctl restart "$ENGINE_SVC" "$FRONTEND_SVC"')
    warm = blk.index("update_wait_for_warm ", restart)
    end = blk.index('update_turn_hold_end "$__HOLD_DIR"', warm)
    assert begin < wait < restart < warm < end
    i = UPDATE.index("on_update_exit() {")
    assert "update_turn_hold_end" in UPDATE[i:i + 700], "a failed or killed update never leaves new turns held"
    assert "$FORCE_NOW -ne 1" in blk[begin - 200:begin]
    assert re.search(r"declare -F update_turn_hold_begin", blk[begin - 200:begin]), "the older installed helper has no hold: carry on without it"

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


def _hb(tmp_path, args, extra="true"):
    return _bash(f'. "{LIB}"; _update_defer_now() {{ echo 5000; }}; _update_defer_sleep() {{ echo "SETTLE $1"; }}; export ORWELL_RUN_DIR="{tmp_path}"; {extra}; update_turn_hold_begin {args}')


@needs_bash
def test_hold_begin_writes_a_future_stamp_in_the_run_dir_and_end_removes_it(tmp_path):
    r = _hb(tmp_path, "240", f'true')
    assert r.returncode == 0, r.stderr
    assert (tmp_path / "turns-hold").read_text() == "until=5240\n"
    assert not list(tmp_path.glob(".turns-hold.*")), "no temp file left behind"
    assert "SETTLE 2" in r.stdout, "a moment is given for a turn admitted in the same instant to register before the first count is read"
    assert _bash(f'. "{LIB}"; export ORWELL_RUN_DIR="{tmp_path}"; update_turn_hold_end').returncode == 0
    assert not (tmp_path / "turns-hold").exists()


@needs_bash
def test_a_symlink_planted_at_the_hold_path_or_as_the_run_dir_is_never_followed(tmp_path):
    victim = tmp_path / "victim.txt"; victim.write_text("keep")
    run = tmp_path / "run"; run.mkdir()
    (run / "turns-hold").symlink_to(victim)                      # the name swapped for a link to a file root must not touch
    r = _hb(run, "240")
    assert r.returncode == 0 and victim.read_text() == "keep", "the link's target was written through"
    assert not (run / "turns-hold").is_symlink() and (run / "turns-hold").read_text() == "until=5240\n"
    # the run dir itself a symlink: nothing is written anywhere
    real = tmp_path / "real"; real.mkdir(); link = tmp_path / "linkdir"; link.symlink_to(real)
    assert _hb(link, "240").returncode == 0 and not list(real.iterdir()), "a symlinked run dir is skipped"
    # the only chmod is on the private temp file (before it is moved into place), never on the final name a link could stand in for
    body = LIB.read_text()[LIB.read_text().index("update_turn_hold_begin() {"):LIB.read_text().index("update_turn_hold_end() {")]
    code = [l.strip() for l in body.splitlines() if not l.strip().startswith("#")]
    chmods = [l for l in code if l.startswith("chmod")]
    assert len(chmods) == 1 and chmods[0].startswith('chmod 644 "$tmp"'), chmods
    assert body.index('chmod 644 "$tmp"') < body.index("mv -fT")


@needs_bash
def test_hold_begin_ignores_a_bad_length(tmp_path):
    _hb(tmp_path, "abc")
    assert (tmp_path / "turns-hold").read_text() == "until=5240\n", "a non-numeric length falls back to 240 s"


def _wait_block():
    i = UPDATE.index("if type update_wait_for_no_turn")
    return UPDATE[i:UPDATE.index('ops_progress_step 4 "restarting services"', i)]


def _run_block(tmp_path, helper_prelude, force_now=0, env=None):
    (tmp_path / "turns-in-flight").write_text("1\n")
    script = f"""set -euo pipefail
{helper_prelude}
FORCE_NOW={force_now}; ENV_FILE=/dev/null; APP_DIR='{tmp_path}'; export ORWELL_INFLIGHT_DIR='{tmp_path}' ORWELL_RUN_DIR='{tmp_path}'
{_wait_block()}
echo "AFTER-WAIT hold=$([ -f '{tmp_path}/turns-hold' ] && echo present || echo absent)"
"""
    return _bash(script, {"ORWELL_INFLIGHT_DIR": str(tmp_path), **(env or {})})


@needs_bash
def test_new_turns_are_held_while_the_updater_waits_for_the_one_in_flight(tmp_path):
    # the real helper; time and sleep stubbed: the turn in flight finishes during the 2nd nap, and the hold is in force at every nap
    prelude = f""". "{LIB}"
NOW=1000; N=0
_update_defer_now() {{ echo $NOW; }}
_update_defer_sleep() {{ [ -f '{tmp_path}/turns-hold' ] || echo "NAP-before-hold-ABSENT"; N=$((N+1)); NOW=$((NOW+$1)); [ -f '{tmp_path}/turns-hold' ] && echo "NAP$N hold=present" || echo "NAP$N hold=ABSENT"; [ $N -ge 2 ] && echo 0 > '{tmp_path}/turns-in-flight' || true; }}
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
    begin = blk.index('update_turn_hold_begin "$__hold"')
    wait = blk.index('update_wait_for_no_turn "${INFLIGHT_DIR:-')
    restart = blk.index('systemctl restart "$ENGINE_SVC" "$FRONTEND_SVC"')
    warm = blk.index("update_wait_for_warm ", restart)
    end = blk.index('update_turn_hold_end', warm)
    assert begin < wait < restart < warm < end
    i = UPDATE.index("on_update_exit() {")
    assert "update_turn_hold_end" in UPDATE[i:i + 700], "a failed or killed update never leaves new turns held"
    assert "$FORCE_NOW -ne 1" in blk[begin - 700:begin]
    assert re.search(r"declare -F update_turn_hold_begin", blk[begin - 700:begin]), "the older installed helper has no hold: carry on without it"


@needs_bash
@pytest.mark.parametrize("value", ["08", "0090", "1x", "", "999999999999", "-5", "0"])
def test_an_odd_turn_wait_value_never_aborts_the_updater_after_the_commit_point(tmp_path, value):
    # "08" is an invalid octal constant, "0090" likewise, "1x" a syntax error: each used to abort `$(( ... + 150 ))` and the whole update after the new code was installed
    prelude = f""". "{LIB}"
_update_defer_now() {{ echo 1000; }}; _update_defer_sleep() {{ echo 0 > '{tmp_path}/turns-in-flight'; }}
"""
    r = _run_block(tmp_path, prelude, env={"ORWELL_UPDATE_TURN_WAIT_SECONDS": value})
    assert r.returncode == 0, (value, r.stdout, r.stderr)
    assert "AFTER-WAIT hold=present" in r.stdout
    stamp = int((tmp_path / "turns-hold").read_text().split("=")[1])
    assert 1000 + 1 + 60 + 150 <= stamp <= 1000 + 300 + 60 + 150, f"the hold lasts the clamped wait (1..300 s) + the warm-up wait (default 60 s) + 150 s: {stamp - 1000}"  # ORW-490


def test_the_updater_uses_the_run_dir_and_the_validated_wait_for_the_hold():
    base = UPDATE.index("RESTART_SCOPE=both")
    blk = UPDATE[base:UPDATE.index("update complete (", base)]
    i = blk.index('update_turn_hold_begin "$__hold"')
    assert "update_hold_seconds" in blk[i - 600:i], "the hold length comes from the shared, clamped bound helper (ORW-490)"
    assert "$(( ${ORWELL_UPDATE_TURN_WAIT_SECONDS" not in UPDATE


@needs_bash
def test_the_hold_and_its_dir_are_readable_by_the_front_end_user_whatever_the_umask(tmp_path):
    # mktemp makes 0600 and a root shell with umask 077 makes a 0700 dir: the front end (another user) could then not open the hold and nothing would be held
    run = tmp_path / "newrun"                                    # does not exist yet: created by the helper
    r = _bash(f'umask 077; . "{LIB}"; _update_defer_now() {{ echo 5000; }}; _update_defer_sleep() {{ :; }}; export ORWELL_RUN_DIR="{run}"; update_turn_hold_begin 240')
    assert r.returncode == 0, r.stderr
    assert oct(run.stat().st_mode & 0o777) == "0o755", "the run dir must be traversable by other users"
    assert oct((run / "turns-hold").stat().st_mode & 0o777) == "0o644", "the hold must be world-readable"
    assert not list(run.glob(".turns-hold.*"))


@needs_bash
def test_a_run_dir_another_writer_made_0700_is_made_traversable_when_the_hold_begins(tmp_path):
    # ORW-489: `mkdir -p -m 755` only applies the mode when it creates the dir; update_run_supersede runs first under root's umask
    run = tmp_path / "run"
    run.mkdir(exist_ok=True)
    run.chmod(0o700)
    r = _hb(run, 240, "umask 077")
    assert r.returncode == 0, r.stderr
    assert oct(run.stat().st_mode & 0o777) == "0o755", "a pre-existing 0700 run dir must be 755 once the hold begins"
    assert (run / "turns-hold").is_file()

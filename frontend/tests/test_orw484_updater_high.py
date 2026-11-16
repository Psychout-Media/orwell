"""ORW-484/485/488: updater hardening. Sandboxed only: the scripts' own blocks/functions are run against temp dirs with stubbed sleeps and
commands; the update script is never run against an install, and nothing touches systemd, pct or chown."""
import os
import re
import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
DEPLOY = ROOT / "deploy"
LIB = DEPLOY / "orwell-live-game.sh"
UPDATE = (DEPLOY / "orwell-update.sh").read_text()
needs_bash = pytest.mark.skipif(shutil.which("bash") is None, reason="bash required")


def _bash(script, env=None):
    return subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=60, env={**os.environ, **(env or {})})


# ── ORW-484: the pushed /tmp copy never sources a planted library as root ─────────────────────────────────────────────
def _lib_section(tmp_path, here):
    """The updater's real library-loading section, with the installed-checkout fallbacks pointed into the sandbox."""
    a = UPDATE.index('__here="$(cd "$(dirname')
    b = UPDATE.index("type tui_active >/dev/null 2>&1 ||")
    c = UPDATE.index("__source_lib orwell-ops-progress.sh || true")
    sec = UPDATE[a:c + len("__source_lib orwell-ops-progress.sh || true")]
    sec = sec.replace("/opt/orwell/deploy", str(tmp_path / "installed")).replace("/opt/bbai/deploy", str(tmp_path / "legacy"))
    sec = sec.replace('__here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"', f'__here="{here}"')
    assert b > a
    return sec


def _plant(d, marker):
    d.mkdir(parents=True, exist_ok=True)
    for n in ("orwell-tui.sh", "orwell-live-game.sh", "orwell-ops-progress.sh"):
        (d / n).write_text(f'echo "SOURCED {marker} {n}"\n')


@needs_bash
def test_a_library_planted_in_a_world_writable_pushed_dir_is_never_sourced_the_installed_copy_is(tmp_path):
    pushed = tmp_path / "tmp"            # stands in for /tmp (mode 1777): any local user may write here
    _plant(pushed, "PLANTED")
    pushed.chmod(0o1777)
    _plant(tmp_path / "installed", "INSTALLED")
    r = _bash(_lib_section(tmp_path, pushed))
    assert r.returncode == 0, r.stderr
    assert "PLANTED" not in r.stdout, "a file in a world-writable dir must never be sourced (this script runs as root)"
    for n in ("orwell-tui.sh", "orwell-live-game.sh", "orwell-ops-progress.sh"):
        assert f"SOURCED INSTALLED {n}" in r.stdout


@needs_bash
def test_a_world_writable_library_file_and_a_symlinked_one_are_refused(tmp_path):
    here = tmp_path / "here"
    _plant(here, "BESIDE")
    here.chmod(0o755)
    (here / "orwell-tui.sh").chmod(0o666)                      # writable by others
    (here / "orwell-live-game.sh").chmod(0o606)                # writable by others
    real = tmp_path / "elsewhere.sh"
    real.write_text('echo "SOURCED BESIDE via-symlink"\n')
    (here / "orwell-ops-progress.sh").unlink()
    (here / "orwell-ops-progress.sh").symlink_to(real)
    _plant(tmp_path / "installed", "INSTALLED")
    r = _bash(_lib_section(tmp_path, here))
    assert "BESIDE" not in r.stdout
    assert r.stdout.count("SOURCED INSTALLED") == 3


@needs_bash
def test_a_normal_private_checkout_dir_is_still_used_beside_the_script(tmp_path):
    here = tmp_path / "checkout" / "deploy"
    _plant(here, "BESIDE")
    here.chmod(0o755)
    for f in here.iterdir():
        f.chmod(0o644)
    _plant(tmp_path / "installed", "INSTALLED")
    r = _bash(_lib_section(tmp_path, here))
    assert r.stdout.count("SOURCED BESIDE") == 3 and "INSTALLED" not in r.stdout


def test_no_library_is_sourced_from_beside_the_script_without_the_trust_check():
    assert "for __lib in" not in UPDATE and "for __lg in" not in UPDATE and "for __pf in" not in UPDATE
    assert re.search(r'if \[\[ "\$d" == "\$__here" \]\]; then __lib_trusted', UPDATE)


# ── ORW-485: a web force request made past the wait does not outlive the run ─────────────────────────────────────────
def _wait(tmp_path, *, on_sleep):
    ops = tmp_path / "ops"
    ops.mkdir(exist_ok=True)
    script = textwrap.dedent(f"""
        . "{LIB}"
        T=1000000; export ORWELL_RUN_DIR='{tmp_path / "run"}'
        _update_defer_now() {{ echo $T; }}
        _update_defer_sleep() {{ T=$((T + $1)); {on_sleep}; }}
        live_game_idle_seconds() {{ printf 30; }}
        rc=0; update_wait_for_idle_game /nonexistent.db '{ops}' 0 '' || rc=$?
        echo "RC=$rc"
    """)
    return _bash(script, {"ORWELL_UPDATE_ROOT_CONF": str(tmp_path / "none.conf")})


@needs_bash
def test_force_pressed_after_the_wait_is_cleared_at_run_end_and_the_next_update_still_waits(tmp_path):
    ops = tmp_path / "ops"
    ops.mkdir()
    # run A is past its wait and building; the admin presses force (the route writes only the flag) -> A finishes
    (ops / "update-force-requested").write_text("now\n")
    r = _bash(f'. "{LIB}"; export ORWELL_RUN_DIR="{tmp_path / "run"}"; update_force_flag_clear "{ops}"')
    assert r.returncode == 0, r.stderr
    assert not (ops / "update-force-requested").exists(), "no update-force-requested flag may remain after a run finishes"
    # the next ordinary update (live game) must wait: with the poll stubbed, 5 minutes later it is still deferred, then the game goes idle
    out = _wait(tmp_path, on_sleep='[[ $T -ge 1000300 ]] && live_game_idle_seconds() { printf 5000; } || true').stdout
    assert "web force request received" not in out and "live-game check skipped" not in out
    assert "RC=0" in out and "proceeding with the update" in out


@needs_bash
def test_force_pressed_while_a_waiter_is_deferred_still_works_and_survives_another_runs_end(tmp_path):
    ops = tmp_path / "ops"
    ops.mkdir(exist_ok=True)
    run = tmp_path / "run"
    run.mkdir()
    (run / "update-deferred").write_text("deferred=true\n")        # a waiter is deferred right now: the flag may be for it
    (ops / "update-force-requested").write_text("now\n")
    _bash(f'. "{LIB}"; export ORWELL_RUN_DIR="{run}"; update_force_flag_clear "{ops}"')
    assert (ops / "update-force-requested").exists()
    (run / "update-deferred").unlink()
    r = _wait(tmp_path, on_sleep=":")
    assert "web force request received" in r.stdout and "RC=0" in r.stdout


@needs_bash
def test_the_updater_clears_the_flag_on_failure_and_on_both_success_exits():
    assert UPDATE.count('update_force_flag_clear "${APP_DIR%/}/data/ops"') == 3
    fn = re.search(r"^on_update_exit\(\) \{.*?^\}\n", UPDATE, re.S | re.M).group(0)
    assert 'update_force_flag_clear "${APP_DIR%/}/data/ops"' in fn.split("[[ \"$rc\" -ne 0 ]]")[0], "cleared before the failure/revert branches, so every exit path gets it"


@needs_bash
def test_on_update_exit_removes_the_flag_even_when_the_run_fails(tmp_path):
    app = tmp_path / "app"
    (app / "data" / "ops").mkdir(parents=True)
    (app / "data" / "ops" / "update-force-requested").write_text("x")
    fn = re.search(r"^on_update_exit\(\) \{.*?^\}\n", UPDATE, re.S | re.M).group(0)
    script = f'. "{LIB}"; export ORWELL_RUN_DIR="{tmp_path / "run"}"; APP_DIR="{app}"; UPDATE_ARMED=0; ops_progress_fail() {{ :; }}\n{fn}\ntrap on_update_exit EXIT\nexit 4'
    r = _bash(script)
    assert r.returncode == 4
    assert not (app / "data" / "ops" / "update-force-requested").exists()


# ── ORW-488: a rollback supersedes a deferred plain update ───────────────────────────────────────────────────────────
@needs_bash
def test_a_deferred_update_exits_after_a_rollback_instead_of_redeploying_the_rejected_tip(tmp_path):
    r = _wait(tmp_path, on_sleep="update_run_supersede rollback")
    assert "RC=10" in r.stdout
    gate = re.search(r'  if \[\[ \$__ud_superseded -eq 1 \]\] && type update_superseded_by_rollback.*?\n  fi\n', UPDATE, re.S).group(0)
    ran = _bash(f'. "{LIB}"; export ORWELL_RUN_DIR="{tmp_path / "run"}"; __ud_superseded=1\n{gate}\necho FELL_THROUGH_TO_DEPLOY')
    assert ran.returncode == 0 and "not redeploying the tip it rejected" in ran.stdout
    assert "FELL_THROUGH_TO_DEPLOY" not in ran.stdout


@needs_bash
def test_a_plain_run_going_ahead_after_the_rollback_is_not_mistaken_for_one_and_a_new_waiter_works(tmp_path):
    run = tmp_path / "run"
    base = f'. "{LIB}"; export ORWELL_RUN_DIR="{run}"; '
    assert _bash(base + 'update_run_supersede rollback; update_superseded_by_rollback && echo YES').stdout.strip() == "YES"
    assert _bash(base + 'update_run_supersede; update_superseded_by_rollback && echo YES || echo NO').stdout.strip() == "NO"
    # after the rollback a waiter that starts fresh and then sees the game go idle still runs (a plain update after a rollback works)
    _bash(base + 'update_run_supersede rollback')
    r = _wait(tmp_path, on_sleep='[[ $T -ge 1000120 ]] && live_game_idle_seconds() { printf 5000; } || true')
    assert "RC=0" in r.stdout


@needs_bash
def test_every_run_that_takes_the_lock_writes_a_fresh_token_rollback_marked():
    m = re.search(r"^acquire_update_lock\n(.*?)\n\n", UPDATE, re.S | re.M)
    assert m, "the token write must follow acquire_update_lock"
    blk = m.group(1)
    assert "ROLLBACK -eq 1" in blk and "SET_TOKEN -eq 1" in blk and "NO_RESTART -eq 1" in blk
    assert "update_run_supersede" in blk and "rollback" in blk


@needs_bash
def test_the_lock_time_token_write_changes_the_token(tmp_path):
    run = tmp_path / "run"
    b = f'. "{LIB}"; export ORWELL_RUN_DIR="{run}"; '
    before = _bash(b + "update_run_seq_read").stdout
    _bash(b + "update_run_supersede rollback")
    after = _bash(b + "update_run_seq_read").stdout
    assert before != after and after.endswith("-rollback")


def test_scripts_parse():
    for n in ("orwell-update.sh", "orwell-live-game.sh"):
        assert subprocess.run(["bash", "-n", str(DEPLOY / n)]).returncode == 0

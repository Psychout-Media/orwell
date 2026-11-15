"""ORW-406 — `--force` skips the idle deferral but never cuts a turn; only `--force-now` skips the turn wait."""
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


def bash(script, env=None):
    full = dict(os.environ)
    full.update(env or {})
    r = subprocess.run(["bash", "-c", f"set -euo pipefail; . '{LIB}'; {script}"],
                       capture_output=True, text=True, timeout=60, env=full)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


def _run(f, on_sleep, force_now=None):
    arg = f" '{force_now}'" if force_now is not None else ""
    return f"""
NOW=1000; SLEEPS=0
_update_defer_now() {{ echo $NOW; }}
_update_defer_sleep() {{ SLEEPS=$((SLEEPS+1)); NOW=$((NOW+$1)); {on_sleep}; }}
update_wait_for_no_turn '{f}'{arg}
echo SLEEPS=$SLEEPS
"""


@needs_bash
def test_forced_run_waits_for_the_turn_then_proceeds(tmp_path):
    f = tmp_path / "turns-in-flight"
    f.write_text("1\n")
    out = bash(_run(f, f'[[ $SLEEPS -ge 3 ]] && echo 0 > "{f}" || true', force_now="0"))
    assert "waiting for it to finish" in out and "SLEEPS=3" in out


@needs_bash
def test_forced_wait_is_still_bounded(tmp_path):
    f = tmp_path / "turns-in-flight"
    f.write_text("1\n")
    out = bash(_run(f, ":", force_now="0"), env={"ORWELL_UPDATE_TURN_WAIT_SECONDS": "10"})
    assert "restarting anyway" in out and "SLEEPS=5" in out


@needs_bash
def test_forced_with_no_turn_does_not_wait(tmp_path):
    f = tmp_path / "turns-in-flight"
    f.write_text("0\n")
    assert "SLEEPS=0" in bash(_run(f, ":", force_now="0"))


@needs_bash
def test_force_now_skips_the_turn_wait(tmp_path):
    f = tmp_path / "turns-in-flight"
    f.write_text("1\n")
    out = bash(_run(f, ":", force_now="1"))
    assert "SLEEPS=0" in out and "--force-now" in out


@needs_bash
def test_unforced_default_unchanged(tmp_path):
    f = tmp_path / "turns-in-flight"
    f.write_text("1\n")
    assert "SLEEPS=5" in bash(_run(f, ":"), env={"ORWELL_UPDATE_TURN_WAIT_SECONDS": "10"})


def _restart_block():
    i = UPDATE.index("RESTART_SCOPE=both")
    return UPDATE[i:UPDATE.index("update complete (")]


def test_updater_wait_is_not_gated_on_force():
    blk = _restart_block()
    assert '"$FORCE" != 1' not in blk
    call = re.search(r'update_wait_for_no_turn "[^"]*" "\$FORCE_NOW"', blk)
    assert call and call.start() < blk.index('systemctl restart "$FRONTEND_SVC"')


def test_force_now_flag_env_and_forwarding():
    assert "--force-now)  FORCE=1; FORCE_NOW=1" in UPDATE
    assert 'ORWELL_UPDATE_FORCE_NOW:-}" == "1" ]] && { FORCE_NOW=1; FORCE=1; }' in UPDATE
    assert '--force-now"' in UPDATE  # forwarded into the container
    # plain --force never sets FORCE_NOW
    assert re.search(r"--force\)\s+FORCE=1 ;;", UPDATE)


def test_log_line_records_the_mode():
    i = UPDATE.index("ops_log_invocation() {")
    blk = UPDATE[i:UPDATE.index("ops_log_invocation \"$@\"")]
    assert "mode=%s" in blk and "force-now" in blk and "normal" in blk


@needs_bash
def test_web_force_request_does_not_become_force_now(tmp_path):
    # the web flag is consumed inside the idle wait as a LOCAL force; the updater's FORCE_NOW stays 0 -> turn wait still runs
    lib = LIB.read_text()
    assert 'force=1; echo "==> web force request received"' in lib
    assert not re.search(r"^\s*FORCE_NOW=", lib, re.M)


def test_usage_documented():
    assert "--force-now" in UPDATE.split("ORW-398")[0]
    assert "ORWELL_UPDATE_FORCE_NOW" in LIB.read_text()


@needs_bash
@pytest.mark.parametrize("script", ["orwell-update.sh", "orwell-live-game.sh"])
def test_bash_syntax(script):
    r = subprocess.run(["bash", "-n", str(ROOT / "deploy" / script)], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


@needs_bash
@pytest.mark.parametrize("force_now,waits", [(1, False), (0, True)])
def test_force_now_holds_even_with_an_old_one_argument_helper(tmp_path, force_now, waits):
    # A host-pushed first update runs THIS script against the pre-update installed helper, whose
    # update_wait_for_no_turn takes one argument and ignores $2: --force-now must not depend on it.
    blk = _restart_block()
    i = blk.index("if type update_wait_for_no_turn")
    wait = blk[i:blk.index('ops_progress_step 4 "restarting services"')]
    r = subprocess.run(["bash", "-c", f"""set -euo pipefail
FORCE_NOW={force_now}; ENV_FILE=/dev/null; APP_DIR='{tmp_path}'
update_wait_for_no_turn() {{ echo "OLD-HELPER-WAITED $#"; }}
{wait}
"""], capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, r.stderr
    assert ("OLD-HELPER-WAITED" in r.stdout) is waits
    if not waits:
        assert "--force-now" in r.stdout


def _watched_dir(tmp_path, env_text, env=None):
    """Run the updater's turn-wait block against a stub helper; return the turns-in-flight path it watches."""
    blk = _restart_block()
    i = blk.index("if type update_wait_for_no_turn")
    wait = blk[i:blk.index('ops_progress_step 4 "restarting services"')]
    envf = tmp_path / ".env"
    envf.write_text(env_text)
    full = {k: v for k, v in os.environ.items() if not k.startswith("ORWELL_")}
    full.update(env or {})
    r = subprocess.run(["bash", "-c", f"""set -euo pipefail
FORCE_NOW=0; ENV_FILE='{envf}'; APP_DIR='/app'
update_wait_for_no_turn() {{ echo "WATCH=$1"; }}
{wait}
"""], capture_output=True, text=True, timeout=30, env=full)
    assert r.returncode == 0, r.stderr
    return r.stdout.split("WATCH=", 1)[1].strip()


@needs_bash
@pytest.mark.parametrize("env_text,env,expected", [
    ("ORWELL_INFLIGHT_DIR=/var/lib/orwell data\n", None, "/var/lib/orwell data/turns-in-flight"),
    ("ORWELL_INFLIGHT_DIR=\"/var/lib/orwell data\"\n", None, "/var/lib/orwell data/turns-in-flight"),
    ("ORWELL_DATA_DIR_FE='/srv/fe'\n", None, "/srv/fe/turns-in-flight"),
    ("ORWELL_DATA_DIR_FE=/srv/fe\nORWELL_INFLIGHT_DIR=/srv/sig\n", None, "/srv/sig/turns-in-flight"),
    ("", {"ORWELL_DATA_DIR_FE": "/env/fe"}, "/env/fe/turns-in-flight"),
    ("", None, "/app/frontend/data/turns-in-flight"),
])
def test_updater_watches_the_directory_the_front_end_publishes_to(tmp_path, env_text, env, expected):
    assert _watched_dir(tmp_path, env_text, env) == expected


@pytest.mark.parametrize("name", ["ORWELL_UPDATE_TURN_WAIT_SECONDS", "ORWELL_UPDATE_WARM_WAIT_SECONDS", "ORWELL_UPDATE_LOCK_WAIT"])
def test_host_bridge_forwards_the_wait_bounds(name):
    # the host-to-container bridge forwards digits-only tunables; a bound set on the host must reach the container run
    m = re.search(r"for __k in ([A-Z_ ]+); do", UPDATE)
    assert m and name in m.group(1).split()

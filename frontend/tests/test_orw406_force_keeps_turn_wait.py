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
    full.pop("ORWELL_UPDATE_TURN_WAIT_SECONDS", None)  # review of #2740: a shell that exports the bound must not change the default-behaviour tests; a test that wants it passes it in `env`
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


@needs_bash
def test_the_turn_wait_bound_is_clamped_to_300_seconds(tmp_path):
    """review of #2740: the advertised upper bound. A bound above 300 behaves as 300: the mocked clock stops there, not at 999."""
    f = tmp_path / "turns-in-flight"
    f.write_text("1\n")
    out = bash(_run(f, ":", force_now="0"), env={"ORWELL_UPDATE_TURN_WAIT_SECONDS": "999"})
    assert "up to 300s" in out and "still in flight after 300s" in out and "SLEEPS=150" in out


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
    """review of #2740: run the real idle wait with a web force-request file. It must set only the LOCAL force (the idle deferral is skipped) and leave `FORCE_NOW` unset, so the turn wait that follows still runs."""
    ops = tmp_path / "ops"
    ops.mkdir()
    (ops / "update-force-requested").write_text("")
    f = tmp_path / "turns-in-flight"
    f.write_text("1\n")
    out = bash(f"""
NOW=1000; SLEEPS=0
export ORWELL_RUN_DIR='{tmp_path / "run"}'
_update_defer_now() {{ echo $NOW; }}
_update_defer_sleep() {{ SLEEPS=$((SLEEPS+1)); NOW=$((NOW+$1)); }}
live_game_idle_seconds() {{ printf '30'; }}
rc=0; update_wait_for_idle_game /nonexistent.db '{ops}' 0 '' || rc=$?
echo "IDLE_RC=$rc FORCE_NOW=${{FORCE_NOW:-unset}} SLEEPS_AFTER_IDLE=$SLEEPS"
update_wait_for_no_turn '{f}' "${{FORCE_NOW:-0}}"
echo "SLEEPS_AFTER_TURN_WAIT=$SLEEPS"
""", env={"ORWELL_UPDATE_ROOT_CONF": str(tmp_path / "none.conf"), "ORWELL_UPDATE_TURN_WAIT_SECONDS": "10"})
    assert "web force request received" in out
    assert "IDLE_RC=0 FORCE_NOW=unset SLEEPS_AFTER_IDLE=0" in out, out
    assert "SLEEPS_AFTER_TURN_WAIT=5" in out and "restarting anyway" in out, "the web force request must not skip the turn wait"
    assert not (ops / "update-force-requested").exists(), "the request is consumed"


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


def test_doctor_names_the_emergency_opt_out_separately():
    doctor = (ROOT / "deploy" / "orwell-doctor.sh").read_text()
    i = doctor.index("update_deferred_check() {")
    blk = doctor[i:doctor.index("\n}\n", i)]
    assert "orwell-update.sh --force\"" in blk
    assert "orwell-update.sh --force-now\"" in blk and "emergency only" in blk and "may be lost" in blk


def _bridge_forward(env):
    i = UPDATE.index("  FWD_LG=\"\"\n")
    blk = UPDATE[i:UPDATE.index("  FWD_ENV=", i)]
    r = subprocess.run(["bash", "-c", f"set -euo pipefail\n{blk}\necho \"FWD=[$FWD_LG]\""], capture_output=True, text=True, timeout=30,
                       env={**{k: v for k, v in os.environ.items() if not k.startswith("ORWELL_")}, **env})
    assert r.returncode == 0, r.stderr
    return r.stdout


@needs_bash
@pytest.mark.parametrize("name", ["ORWELL_UPDATE_LOCK_WAIT", "ORWELL_UPDATE_TURN_WAIT_SECONDS", "ORWELL_UPDATE_WARM_WAIT_SECONDS"])
def test_bridge_caps_the_wait_bounds(name):
    assert f"{name}='86400'" in _bridge_forward({name: "86400"})
    for bad in ("86401", "99999999999999999999"):
        out = _bridge_forward({name: bad})
        assert name + "='" not in out and "ignored" in out and "FWD=[]" in out


@needs_bash
@pytest.mark.parametrize("value,waits", [("120", "120"), ("86400", "86400"), ("99999999999999999999", "3600"), ("86401", "3600"), ("abc", "3600")])
def test_lock_wait_is_capped(value, waits):
    i = UPDATE.index('    local _w="${ORWELL_UPDATE_LOCK_WAIT:-3600}"')
    blk = UPDATE[i:UPDATE.index("    _flock_args=(-w", i)]
    r = subprocess.run(["bash", "-c", f"set -euo pipefail\nf() {{\n{blk}\necho \"W=$_w\"\n}}\nf"], capture_output=True, text=True, timeout=30,
                       env={**os.environ, "ORWELL_UPDATE_LOCK_WAIT": value})
    assert r.returncode == 0, r.stderr
    assert f"W={waits}" in r.stdout


@needs_bash
def test_helper_ignores_a_wrapping_turn_wait(tmp_path):
    var = "ORWELL_UPDATE_TURN_WAIT_SECONDS"
    f = tmp_path / "turns-in-flight"
    f.write_text("1\n")
    # a 20-digit value falls back to the default bound (120 s => 60 two-second naps), never wraps to a 1 s wait
    out = bash(_run(f, ":", force_now="0"), env={var: "99999999999999999999"})
    assert "SLEEPS=60" in out

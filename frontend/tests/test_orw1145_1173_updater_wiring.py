"""ORW-1145 / ORW-1173: the updater and the doctor call the standalone scripts (deploy/orwell-deploy-hold.sh, deploy/ensure-internal-token.sh).

The updater's hold gate and the doctor function are cut out of the scripts and run in bash; the token step is pinned to sit inside the updater before the model prefetch."""
import os
import re
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LIB = ROOT / "deploy" / "orwell-deploy-hold.sh"
UPDATE = (ROOT / "deploy" / "orwell-update.sh").read_text()
DOCTOR = (ROOT / "deploy" / "orwell-doctor.sh").read_text()


def _gate(tmp_path, env=None):
    start = UPDATE.index("# ORW-1145: a dev live check holds the deploy")
    end = UPDATE.index("if [[ $ROLLBACK -eq 0 && $SET_TOKEN -eq 0 && $NO_RESTART -eq 0 ]] && type update_wait_for_idle_game")
    (tmp_path / "data").mkdir(exist_ok=True)
    script = f'source "{LIB}"; APP_DIR="{tmp_path}"; ROLLBACK=0; SET_TOKEN=0\n' + UPDATE[start:end] + "\necho PROCEEDED\n"
    return subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=30, env=dict(os.environ, **(env or {})))


def _hold(tmp_path, secs=600):
    f = tmp_path / "data" / ".deploy-hold"
    f.write_text(f"until={int(time.time() + secs)}\n")


def test_a_held_update_exits_zero_and_changes_nothing(tmp_path):
    _gate(tmp_path)
    _hold(tmp_path)
    r = _gate(tmp_path)
    assert r.returncode == 0 and "deploy HELD until" in r.stdout and "PROCEEDED" not in r.stdout


def test_no_hold_or_ignore_hold_lets_the_update_proceed(tmp_path):
    assert "PROCEEDED" in _gate(tmp_path).stdout
    _hold(tmp_path)
    assert "PROCEEDED" in _gate(tmp_path, {"ORWELL_UPDATE_IGNORE_HOLD": "1"}).stdout


def test_the_hold_check_runs_before_the_update_lock_and_rollback_skips_it():
    assert UPDATE.index("deploy HELD until") < UPDATE.index("acquire_update_lock\n")
    assert "$ROLLBACK -eq 0 && $SET_TOKEN -eq 0 && \"${ORWELL_UPDATE_IGNORE_HOLD:-0}\" != 1" in UPDATE
    assert "--ignore-hold" in UPDATE and "orwell-deploy-hold.sh" in UPDATE


def test_the_updater_ensures_the_token_before_the_model_prefetch():
    assert UPDATE.index("ensure-internal-token.sh") < UPDATE.index("# Resolve the embedding-model cache dir")


def test_the_updater_step_mints_once_against_a_real_env_file(tmp_path):
    env = tmp_path / ".env"
    env.write_text("A=1\n")
    for _ in range(2):
        subprocess.run(["bash", str(ROOT / "deploy" / "ensure-internal-token.sh"), str(env)], check=True, capture_output=True, timeout=30)
    assert len([l for l in env.read_text().splitlines() if l.startswith("ORWELL_INTERNAL_TOKEN=")]) == 1


def test_the_doctor_warns_when_unset_and_passes_quietly_when_set(tmp_path):
    fn = re.search(r"^internal_token_check\(\) \{.*?^\}\n", DOCTOR, re.S | re.M)
    assert fn and "internal_token_check\n  token_security_check" in DOCTOR
    env = tmp_path / ".env"

    def run(text):
        env.write_text(text)
        script = f'APP_DIR="{ROOT}"; ENV_FILE="{env}"\n' + fn.group(0) + "\ninternal_token_check\n"
        return subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=30).stdout

    assert run("A=1\n").strip().startswith("warn")
    out = run("ORWELL_INTERNAL_TOKEN=sekrit123\n")
    assert out.strip().startswith("ok") and "sekrit123" not in out

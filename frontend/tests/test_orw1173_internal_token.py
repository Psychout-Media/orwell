"""ORW-1173: ORWELL_INTERNAL_TOKEN is minted into data/.env once (never overwritten, never printed); the doctor warns when it is unset.

The updater's data/.env reconcile block and the doctor function are cut out of the scripts and run in bash against a temp dir."""
import os
import re
import subprocess
import textwrap

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
UPDATE = os.path.join(ROOT, "deploy", "orwell-update.sh")
DOCTOR = os.path.join(ROOT, "deploy", "orwell-doctor.sh")
INSTALL = os.path.join(ROOT, "deploy", "orwell-install.sh")
KEY = "ORWELL_INTERNAL_TOKEN"


def _reconcile(tmp_path):
    src = open(UPDATE, encoding="utf-8").read()
    start = src.index('PHASE="the data/.env reconcile"')
    end = src.index("# Resolve the embedding-model cache dir")
    block = src[start:end]
    script = textwrap.dedent(f'''
        set -e
        APP_DIR="{tmp_path}"
        ENV_FILE="{tmp_path}/data/.env"
        __here="{ROOT}/deploy"
        PHASE=x
        ''') + block
    return subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=60)


def _env(tmp_path, text):
    (tmp_path / "data").mkdir(exist_ok=True)
    (tmp_path / "data" / ".env").write_text(text)


def _lines(tmp_path):
    return (tmp_path / "data" / ".env").read_text().splitlines()


def test_update_mints_the_token_once_and_never_prints_it(tmp_path):
    _env(tmp_path, "ORWELL_PORT=3000\n")
    r = _reconcile(tmp_path)
    assert r.returncode == 0, r.stderr
    vals = [l.split("=", 1)[1] for l in _lines(tmp_path) if l.startswith(KEY + "=")]
    assert len(vals) == 1 and re.fullmatch(r"[0-9a-f]{64}", vals[0])
    assert vals[0] not in r.stdout + r.stderr
    assert KEY + "(minted)" in r.stdout


def test_update_never_overwrites_an_existing_token(tmp_path):
    _env(tmp_path, f"{KEY}=keepme\n")
    r = _reconcile(tmp_path)
    assert r.returncode == 0, r.stderr
    assert [l for l in _lines(tmp_path) if l.startswith(KEY)] == [f"{KEY}=keepme"]
    r2 = _reconcile(tmp_path)
    assert [l for l in _lines(tmp_path) if l.startswith(KEY)] == [f"{KEY}=keepme"]


def test_a_second_run_adds_no_second_token(tmp_path):
    _env(tmp_path, "ORWELL_PORT=3000\n")
    _reconcile(tmp_path)
    first = [l for l in _lines(tmp_path) if l.startswith(KEY)]
    _reconcile(tmp_path)
    assert [l for l in _lines(tmp_path) if l.startswith(KEY)] == first


def test_first_install_writes_the_token():
    src = open(INSTALL, encoding="utf-8").read()
    assert 'echo "ORWELL_INTERNAL_TOKEN=$(openssl rand' in src


def _doctor(tmp_path, env_text):
    src = open(DOCTOR, encoding="utf-8").read()
    fn = re.search(r"^internal_token_check\(\) \{.*?^\}\n", src, re.S | re.M)
    assert fn, "internal_token_check is in the doctor"
    if env_text is not None:
        (tmp_path / ".env").write_text(env_text)
    script = textwrap.dedent(f'''
        pass() {{ echo "pass: $*"; }}
        warn() {{ echo "warn: $*"; }}
        ENV_FILE="{tmp_path}/.env"
        APP_DIR=/opt/orwell
        ''') + fn.group(0) + "\ninternal_token_check\n"
    return subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=30).stdout


def test_doctor_warns_when_unset(tmp_path):
    assert _doctor(tmp_path, "ORWELL_PORT=1\n").startswith("warn: ORWELL_INTERNAL_TOKEN is not set")
    assert _doctor(tmp_path, f"{KEY}=\n").startswith("warn:")


def test_doctor_is_quiet_when_set_and_never_prints_it(tmp_path):
    out = _doctor(tmp_path, f"{KEY}=sekrit123\n")
    assert out.startswith("pass:") and "sekrit123" not in out

"""ORW-1173: ORWELL_INTERNAL_TOKEN is minted into data/.env once (never overwritten, never printed); the check warns when it is unset.

deploy/ensure-internal-token.sh is run for real against a temp env file. (Its one-line calls from orwell-update.sh and orwell-doctor.sh land after the open ORW-1074 PR merges.)"""
import os
import re
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCRIPT = os.path.join(ROOT, "deploy", "ensure-internal-token.sh")
INSTALL = os.path.join(ROOT, "deploy", "orwell-install.sh")
KEY = "ORWELL_INTERNAL_TOKEN"


def _run(path, *args):
    return subprocess.run(["bash", SCRIPT, *args, str(path)], capture_output=True, text=True, timeout=60)


def _lines(path):
    return path.read_text().splitlines()


def test_mints_once_and_never_prints_it(tmp_path):
    f = tmp_path / ".env"
    f.write_text("ORWELL_PORT=3000\n")
    f.chmod(0o600)
    r = _run(f)
    assert r.returncode == 0, r.stderr
    vals = [l.split("=", 1)[1] for l in _lines(f) if l.startswith(KEY + "=")]
    assert len(vals) == 1 and re.fullmatch(r"[0-9a-f]{64}", vals[0])
    assert vals[0] not in r.stdout + r.stderr
    assert oct(f.stat().st_mode & 0o777) == "0o600" and "ORWELL_PORT=3000" in _lines(f)


def test_never_overwrites_and_a_second_run_is_a_no_op(tmp_path):
    f = tmp_path / ".env"
    f.write_text(f"{KEY}=keepme\n")
    assert _run(f).returncode == 0
    assert [l for l in _lines(f) if l.startswith(KEY)] == [f"{KEY}=keepme"]
    g = tmp_path / "second.env"
    g.write_text("A=1\n")
    _run(g)
    first = [l for l in _lines(g) if l.startswith(KEY)]
    _run(g)
    assert [l for l in _lines(g) if l.startswith(KEY)] == first


def test_an_empty_value_counts_as_unset(tmp_path):
    f = tmp_path / ".env"
    f.write_text(f"{KEY}=\n")
    _run(f)
    assert len([l for l in _lines(f) if re.fullmatch(KEY + "=[0-9a-f]{64}", l)]) == 1


def test_check_warns_when_unset_and_is_quiet_about_the_value_when_set(tmp_path):
    f = tmp_path / ".env"
    f.write_text("A=1\n")
    r = _run(f, "--check")
    assert r.returncode == 1 and r.stdout.strip().startswith("warn") and KEY in r.stdout
    f.write_text(f"{KEY}=sekrit123\n")
    r = _run(f, "--check")
    assert r.returncode == 0 and r.stdout.strip().startswith("ok") and "sekrit123" not in r.stdout


def test_a_missing_env_file_is_not_created(tmp_path):
    f = tmp_path / "absent.env"
    assert _run(f).returncode == 0 and not f.exists()


def test_first_install_writes_the_token():
    src = open(INSTALL, encoding="utf-8").read()
    assert 'echo "ORWELL_INTERNAL_TOKEN=$(openssl rand' in src

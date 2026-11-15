"""ORW-406 — releases must not interrupt play: restart only what changed, swap between turns."""
import os
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


@needs_bash
@pytest.mark.parametrize("paths,expected", [
    ("frontend/static/js/a.js\\nfrontend/static/css/b.css", "none"),
    ("frontend/static/js/a.js\\nfrontend/routes/chat_routes.py", "frontend"),
    ("frontend/requirements.lock.txt", "frontend"),
    ("frontend/routes/x.py\\nsrc/engine.ts", "both"),
    ("frontend/static/a.js\\npackage-lock.json", "both"),
    ("deploy/systemd/orwell-frontend.service", "both"),
    ("docs/x.md", "both"),
    ("", "both"),
])
def test_restart_scope(paths, expected):
    assert bash(f"update_restart_scope \"$(printf '{paths}')\"") == expected


LOOP = """
NOW=1000; SLEEPS=0
_update_defer_now() { echo $NOW; }
_update_defer_sleep() { SLEEPS=$((SLEEPS+1)); NOW=$((NOW+$1)); @@S@@; }
update_wait_for_no_turn '@@F@@'
echo SLEEPS=$SLEEPS
"""


def _loop(f, on_sleep):
    return LOOP.replace("@@S@@", on_sleep).replace("@@F@@", str(f))


@needs_bash
def test_turn_in_flight_delays_until_it_ends(tmp_path):
    f = tmp_path / "turns-in-flight"
    f.write_text("1\n")
    out = bash(_loop(f, f'[[ $SLEEPS -ge 3 ]] && echo 0 > "{f}" || true'))
    assert "waiting for it to finish" in out and "SLEEPS=3" in out


@needs_bash
def test_turn_wait_is_bounded(tmp_path):
    f = tmp_path / "turns-in-flight"
    f.write_text("2\n")
    out = bash(_loop(f, ":"), env={"ORWELL_UPDATE_TURN_WAIT_SECONDS": "10"})
    assert "restarting anyway" in out and "SLEEPS=5" in out


@needs_bash
def test_no_turn_missing_or_junk_file_does_not_wait(tmp_path):
    f = tmp_path / "turns-in-flight"
    assert "SLEEPS=0" in bash(_loop(f, ":"))
    f.write_text("0\n")
    assert "SLEEPS=0" in bash(_loop(f, ":"))
    f.write_text("junk")
    assert "SLEEPS=0" in bash(_loop(f, ":"))


def test_updater_wiring():
    i = UPDATE.index("RESTART_SCOPE=both")
    blk = UPDATE[i:UPDATE.index("update complete (")]
    assert 'update_restart_scope' in blk and 'update_wait_for_no_turn' in blk
    assert blk.index("update_wait_for_no_turn") < blk.index('systemctl restart "$FRONTEND_SVC"')
    assert 'systemctl restart "$ENGINE_SVC" "$FRONTEND_SVC"' in blk
    assert "none" in blk


def test_frontend_publishes_turns_in_flight(tmp_path, monkeypatch):
    monkeypatch.setenv("ORWELL_INFLIGHT_DIR", str(tmp_path))
    from src.turn_inflight import InflightRegistry
    reg = InflightRegistry()
    f = tmp_path / "turns-in-flight"
    reg["s1"] = {"status": "streaming"}
    assert f.read_text().strip() == "1"
    reg["s2"] = {}
    assert f.read_text().strip() == "2"
    reg.pop("s1", None)
    reg.pop("missing", None)
    assert f.read_text().strip() == "1"
    reg.pop("s2")
    assert f.read_text().strip() == "0"
    assert "s1" not in reg and len(reg) == 0

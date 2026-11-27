"""ORW-1018: the doctor counts the engine's `[orwell] SLOW step=` lines per day and step, and warns when a save the turn waits on (`save.persist`) is slow.

The function is cut out of deploy/orwell-doctor.sh and run in bash with a fake `journalctl` on PATH (no root, no real journal)."""
import os
import re
import subprocess
import textwrap

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DOCTOR = os.path.join(ROOT, "deploy", "orwell-doctor.sh")


def _run(journal: str, tmp_path) -> str:
    src = open(DOCTOR, encoding="utf-8").read()
    fn = re.search(r"^slow_steps_check\(\) \{.*?^\}\n", src, re.S | re.M)
    assert fn, "slow_steps_check is in the doctor"
    fake = tmp_path / "journalctl"
    fake.write_text("#!/bin/bash\ncat <<'EOF'\n" + journal + "EOF\n")
    fake.chmod(0o755)
    script = textwrap.dedent('''
        info() { echo "info: $*"; }
        warn() { echo "warn: $*"; }
        ENGINE_SVC=orwell-engine
        ''') + fn.group(0) + "\nslow_steps_check\n"
    env = dict(os.environ, PATH=f"{tmp_path}:{os.environ['PATH']}")
    return subprocess.run(["bash", "-c", script], capture_output=True, text=True, env=env, timeout=30).stdout


def test_counts_per_day_and_step(tmp_path):
    out = _run("2026-11-26T11:23:05+0000 h node: [orwell] SLOW step=save.fsync ms=7134 version=69\n"
               "2026-11-26T11:24:05+0000 h node: [orwell] SLOW step=save.fsync ms=5100 version=70\n"
               "2026-11-27T01:00:00+0000 h node: [orwell] SLOW step=embed.call ms=900 chars=40\n", tmp_path)
    assert out.startswith("info: slow steps per day"), out
    assert "2026-11-26 save.fsync=2" in out and "2026-11-27 embed.call=1" in out


def test_a_slow_save_the_turn_waits_on_warns(tmp_path):
    out = _run("2026-11-26T11:23:05+0000 h node: [orwell] SLOW step=save.persist ms=900 chars=100\n", tmp_path)
    assert out.startswith("warn: slow saves on the request path: 1"), out


def test_nothing_logged_is_one_info_line(tmp_path):
    out = _run("2026-11-26T11:23:05+0000 h node: something else\n", tmp_path)
    assert out.startswith("info: slow steps: none logged"), out

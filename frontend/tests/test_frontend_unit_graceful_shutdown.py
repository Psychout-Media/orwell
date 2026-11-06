"""The front-end unit must stop in seconds, not 90 s + SIGKILL.

uvicorn waits forever for open streams after SIGTERM unless --timeout-graceful-shutdown is set, so systemd's
default 90 s TimeoutStopSec ended every release in 'stop-sigterm timed out. Killing.' These pin both lines.
"""
import re
from pathlib import Path

UNIT = (Path(__file__).resolve().parents[2] / "deploy" / "systemd" / "orwell-frontend.service").read_text()


def _exec_start():
    m = re.search(r"^ExecStart=(.*)$", UNIT, re.M)
    assert m
    return m.group(1)


def test_uvicorn_has_a_bounded_graceful_shutdown():
    m = re.search(r"--timeout-graceful-shutdown\s+(\d+)", _exec_start())
    assert m, "ExecStart must pass --timeout-graceful-shutdown"
    assert 1 <= int(m.group(1)) <= 15


def test_unit_has_a_hard_stop_backstop_above_the_graceful_window():
    m = re.search(r"^TimeoutStopSec=(\d+)\s*$", UNIT, re.M)
    assert m, "unit must set TimeoutStopSec"
    graceful = int(re.search(r"--timeout-graceful-shutdown\s+(\d+)", _exec_start()).group(1))
    assert graceful < int(m.group(1)) <= 60

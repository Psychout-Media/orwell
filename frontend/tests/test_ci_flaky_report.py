"""ORW-229 flaky-test rule (docs/CI.md): a test that passes only on CI's automatic rerun is a flake, and it must show up in the job summary.

The unit tests pin the classification; the last one runs a real nested pytest under xdist (like fe-unit) with `--reruns 1` over a test that fails
once, and checks the GitHub job summary the plugin writes."""
from __future__ import annotations

import os
import subprocess
import sys
import textwrap
from pathlib import Path
from types import SimpleNamespace as R

from _ci_shard import nested_env
from _flaky_report import flakes, summary_markdown

TESTS = Path(__file__).resolve().parent


def test_a_test_rerun_then_passed_is_flaky_and_one_rerun_then_failed_is_still_red():
    stats = {
        "rerun": [R(nodeid="t.py::wobbly"), R(nodeid="t.py::broken"), R(nodeid="t.py::broken")],
        "passed": [R(nodeid="t.py::wobbly", when="call"), R(nodeid="t.py::steady", when="call")],
        "failed": [R(nodeid="t.py::broken", when="call"), R(nodeid="t.py::red_once", when="call")],
    }
    flaky, still_red = flakes(stats)
    assert flaky == [("t.py::wobbly", 1)]
    assert still_red == [("t.py::broken", 2)]
    md = summary_markdown(flaky, still_red, "unit")
    assert "### Flaky tests (pytest, unit)" in md
    assert "**1 test(s) failed, then passed on the automatic rerun.**" in md and "| t.py::wobbly | 1 |" in md
    assert "**1 test(s) were still red after the rerun**" in md and "- t.py::broken" in md


def test_nothing_to_report_writes_nothing():
    assert flakes({"passed": [R(nodeid="t.py::a", when="call")]}) == ([], [])
    assert summary_markdown([], [], "unit") == ""


def test_a_real_xdist_run_with_reruns_reports_the_flake_in_the_job_summary(tmp_path):
    flag = tmp_path / "failed-once"
    (tmp_path / "test_wobbly.py").write_text(textwrap.dedent(f'''
        from pathlib import Path
        def test_fails_on_the_first_try_only():
            flag = Path({str(flag)!r})
            if not flag.exists():
                flag.write_text("1")
                raise AssertionError("first try")
        def test_steady():
            pass
    '''), encoding="utf-8")
    summary = tmp_path / "summary.md"
    summary.write_text("", encoding="utf-8")
    env = nested_env(os.environ)
    env.update({"GITHUB_STEP_SUMMARY": str(summary), "ORWELL_SKIP_LANE": "unit", "PYTHONPATH": os.pathsep.join([str(TESTS), env.get("PYTHONPATH", "")])})
    r = subprocess.run([sys.executable, "-m", "pytest", "-p", "_flaky_report", "-p", "no:cacheprovider", "-n", "2", "--reruns", "1", "-q", str(tmp_path)],
                       cwd=tmp_path, env=env, capture_output=True, text=True, timeout=180)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "flaky tests (ORW-229): 1 passed only on a rerun, 0 still red after a rerun" in r.stdout
    assert "::warning title=Flaky test (passed on rerun)::test_wobbly.py::test_fails_on_the_first_try_only" in r.stdout
    md = summary.read_text(encoding="utf-8")
    assert "### Flaky tests (pytest, unit)" in md and "| test_wobbly.py::test_fails_on_the_first_try_only | 1 |" in md

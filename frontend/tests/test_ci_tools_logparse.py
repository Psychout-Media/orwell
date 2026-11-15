"""ORW-415: the CI tools' log parsers (scripts/ci/ci_logparse.py) and the quarantine patch maker, pinned against fixtures cut from real job logs.

Run from frontend/:  .venv/bin/python -m pytest tests/test_ci_tools_logparse.py -q     (or plain: python3 tests/test_ci_tools_logparse.py)
Fixtures (tests/fixtures/ci_logs/) are excerpts of CI run 43689257171 (pytest, fe-unit 1/2), 43688725229 (vitest test-unit 4, cucumber bdd), 43689315331
(pytest browser) and 43666915304 (the flaky-test summary of fe-browser-tests 2/5), timestamps and colour codes included."""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
FIX = Path(__file__).resolve().parent / "fixtures" / "ci_logs"


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, REPO / "scripts" / "ci" / filename)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


parse = _load("ci_logparse", "ci_logparse.py")
quar = _load("quarantine_flakes", "quarantine-flakes.py")


def _fx(name: str) -> str:
    return (FIX / name).read_text(encoding="utf-8")


def test_pytest_failure_names_the_test_and_the_error_line():
    r = parse.parse_failures(_fx("pytest_failure.txt"))
    assert r["tests"] == ["test_the_backup_script_checkpoints_the_wal_before_tar"]
    assert r["errors"] == ["ValueError: substring not found"]


def test_pytest_browser_failure():
    r = parse.parse_failures(_fx("pytest_browser_failure.txt"))
    assert r["tests"] == ["test_a_week_picked_while_the_chat_reloads_is_the_week_that_stays"]
    assert r["errors"][0].startswith("playwright._impl._errors.TimeoutError")


def test_vitest_failure_strips_colour_codes_and_reports_the_assertion():
    r = parse.parse_failures(_fx("vitest_failure.txt"))
    assert len(r["tests"]) == 1 and r["tests"][0].startswith("tests/unit/beatsTerminateThemselves.test.ts > T0-2")
    assert "\x1b" not in r["tests"][0]
    assert r["errors"] == ["AssertionError: seed 1 should float a deal offer on a chained submitDecision call: expected null not to be null"]


def test_cucumber_failures_block_lists_every_scenario_with_its_failing_step():
    r = parse.parse_failures(_fx("cucumber_failure.txt"))
    assert r["tests"] == ["The calibration floor runs on the intentional-movement model", "The day-one read never changes even as the current read moves"]
    assert "step failed: Then it yields a well-formed outcome the band gate can score" in r["errors"]
    assert any(e.startswith("AssertionError [ERR_ASSERTION]: seed 1") for e in r["errors"])


def test_a_log_without_failures_parses_to_nothing():
    assert parse.parse_failures("2026-11-15T07:17:57.0Z all good\n") == {"tests": [], "errors": []}


def test_a_failed_build_step_reports_the_runner_error_annotation():
    r = parse.parse_failures("2026-11-15T07:17:57.0Z ##[error]Process completed with exit code 1.\n")
    assert r == {"tests": [], "errors": ["Process completed with exit code 1."]}


def test_pytest_flaky_summary_is_read_once_despite_the_annotation_duplicate():
    assert parse.parse_flakes(_fx("pytest_flaky.txt")) == [
        "tests/test_orw275_chapters.py::test_the_bar_shows_the_current_week_and_a_past_week_is_one_tap_away"]


def test_vitest_and_gate_flake_annotations_are_read_but_the_echoed_shell_source_is_not():
    log = ("2026-11-15T02:00:00.0Z ##[warning]tests/unit/x.test.ts > suite > a test\n"
           "2026-11-15T02:00:01.0Z ##[warning]mirror-parity (WS) passed only on attempt 2\n"
           '2026-11-15T02:00:02.0Z   [ "$attempt" -eq 1 ] || { echo "::warning title=Flaky gate (passed on a retry)::mirror-hud (WS) passed only on attempt $attempt"; }\n'
           "2026-11-15T02:00:03.0Z ##[warning]Node.js 20 actions are deprecated\n")
    assert parse.parse_flakes(log) == ["tests/unit/x.test.ts > suite > a test", "mirror-parity (WS) passed only on attempt 2"]


def test_known_flake_matching_takes_a_bare_name_or_the_full_node_id(tmp_path):
    f = tmp_path / "flakes.txt"
    f.write_text("# comment\n\ntest_a_flake  # trailing comment\n")
    known = parse.load_flakes(str(f))
    assert known == ["test_a_flake"]
    assert parse.all_known_flakes(["tests/test_x.py::test_a_flake"], known)
    assert not parse.all_known_flakes(["test_a_flake", "test_other"], known)  # one unknown failure makes the job real
    assert not parse.all_known_flakes([], known)  # no failing test found: never treated as a flake


def test_the_shipped_known_flake_list_parses():
    known = parse.load_flakes(str(REPO / "scripts" / "ci" / "known-flakes.txt"))
    assert "test_the_bar_shows_the_current_week_and_a_past_week_is_one_tap_away" in known


def test_quarantine_patch_puts_the_marker_above_the_test_and_its_decorators(tmp_path):
    (tmp_path / "frontend" / "tests").mkdir(parents=True)
    (tmp_path / "frontend" / "tests" / "test_x.py").write_text(
        "import pytest\n\n\n@pytest.mark.browser\ndef test_a_flake(_stack):\n    pass\n\n\nclass TestK:\n    def test_in_class(self):\n        pass\n")
    patch = quar.pytest_patch("tests/test_x.py::test_a_flake[param]", "ORW-123", "2026-11-15", tmp_path)
    assert patch is not None and "--- a/frontend/tests/test_x.py" in patch
    lines = patch.splitlines()
    i = lines.index('+@pytest.mark.quarantine(card="ORW-123", added="2026-11-15")')
    assert lines[i + 1] == " @pytest.mark.browser"  # existing decorators stay under it
    in_class = quar.pytest_patch("tests/test_x.py::TestK::test_in_class", "ORW-1", "2026-11-15", tmp_path)
    assert '+    @pytest.mark.quarantine(card="ORW-1", added="2026-11-15")' in in_class  # indentation kept


def test_quarantine_patch_for_an_unknown_test_is_none():
    assert quar.pytest_patch("tests/test_nope.py::test_x", "ORW-1", "2026-11-15", REPO) is None


def test_quarantine_report_counts_runs_per_test():
    agg = quar.aggregate({1: [("fe-unit (1/2)", "tests/test_nope.py::test_x")], 2: [("fe-unit (2/2)", "tests/test_nope.py::test_x")]})
    out = quar.render(agg, 20, "2026-11-15", REPO)
    assert "2/20 runs  tests/test_nope.py::test_x" in out and "mark it by hand" in out


if __name__ == "__main__":
    import pytest
    sys.exit(pytest.main([__file__, "-q"]))


def test_pytest_setup_and_teardown_errors_are_named_too():
    # review of #2698: a job that fails only through a fixture error has an ERRORS section and `ERROR ...` summary lines, no FAILURES section.
    log = (
        "=================================== ERRORS ====================================\n"
        "_________________ ERROR at setup of test_the_fixture_breaks _________________\n"
        "E   RuntimeError: no browser\n"
        "=========================== short test summary info ===========================\n"
        "ERROR tests/test_x.py::test_the_fixture_breaks - RuntimeError: no browser\n"
    )
    r = parse.parse_failures(log)
    assert r["tests"] == ["test_the_fixture_breaks"], r
    assert r["errors"] and "RuntimeError: no browser" in r["errors"][0]


def test_quarantine_patch_picks_the_method_of_the_named_class(tmp_path):
    # review of #2698: two classes with the same method name; the node id names the second one.
    f = tmp_path / "frontend" / "tests"; f.mkdir(parents=True)
    (f / "test_y.py").write_text("import pytest\n\nclass TestA:\n    def test_same(self):\n        pass\n\nclass TestB:\n    def test_same(self):\n        pass\n")
    patch = quar.pytest_patch("tests/test_y.py::TestB::test_same", "ORW-1", "2026-11-15", tmp_path)
    assert patch and "+    @pytest.mark.quarantine" in patch
    assert " class TestB:" in patch  # the hunk's context sits under TestB, not TestA
    assert quar.pytest_patch("tests/test_y.py::TestC::test_same", "ORW-1", "2026-11-15", tmp_path) is None


def test_parametrized_variants_give_one_patch_hunk(tmp_path):
    f = tmp_path / "frontend" / "tests"; f.mkdir(parents=True)
    (f / "test_z.py").write_text("import pytest\n\ndef test_p():\n    pass\n")
    agg = {"tests/test_z.py::test_p[a]": {"runs": {1}, "jobs": {"j"}}, "tests/test_z.py::test_p[b]": {"runs": {1}, "jobs": {"j"}}}
    out = quar.render(agg, 1, "2026-11-15", tmp_path)
    assert out.count("+@pytest.mark.quarantine") == 1


def test_watch_pr_rejects_a_bad_or_empty_run_id_before_touching_github():
    # review of #2698: an empty --run used to switch a read-only replay into live mode.
    import subprocess
    for bad in ("abc", ""):
        r = subprocess.run(["bash", str(REPO / "scripts" / "ci" / "watch-pr.sh"), "5", "--run", bad], capture_output=True, text=True, timeout=20)
        assert r.returncode == 64 and "numeric run id" in r.stderr, (bad, r.returncode, r.stderr)


def test_watch_pr_source_pins_for_the_gate_rerun_and_attempt_floor_fixes():
    src = (REPO / "scripts" / "ci" / "watch-pr.sh").read_text()
    assert '"$gate" = success ] && [ "${#flakejobs[@]}" -eq 0 ] && [ "${#cancelled[@]}" -eq 0' in src  # a green gate with a recorded cancellation still re-runs
    assert 'RE-RUN REJECTED' in src                                                                       # a failed `gh run rerun` is not scheduled work
    assert '"$rid" != "$last_rid"' in src                                                               # a new run resets the attempt floor
    assert '*onflict*) say "PR #$pr has a MERGE CONFLICT' in src                                       # a conflict found at merge time is exit 3


def test_pr_overlap_reads_renames_and_paginates():
    src = (REPO / "scripts" / "ci" / "pr-overlap.sh").read_text()
    assert "previous_filename" in src and "--paginate" in src and "--limit 200" not in src

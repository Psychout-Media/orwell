"""ORW-193: the CI shard partition is disjoint, complete, balanced and deterministic."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from _ci_refresh_durations import parse_log
from _ci_shard import DURATIONS_PATH, MIN_WEIGHT, assign_files, classify_missing, files_added_by_this_change, load_durations, nested_env, parse_shard, select_shard, weigh_files


def test_partition_is_disjoint_and_complete():
    files = [f"tests/f{i}.py" for i in range(40) for _ in range(1 + i % 7)]
    for total in (1, 2, 3, 4):
        parts = [select_shard(files, i, total) for i in range(1, total + 1)]
        assert sum(len(p) for p in parts) == len(set(files))
        assert set().union(*parts) == set(files)


def test_balanced_within_the_largest_file():
    counts = {f"f{i}": 1 + (i * 7) % 11 for i in range(30)}
    a = assign_files(counts, 3)
    loads = [sum(n for f, n in counts.items() if a[f] == k) for k in (1, 2, 3)]
    assert max(loads) - min(loads) <= max(counts.values())


def test_deterministic():
    counts = {"b": 3, "a": 3, "c": 1}
    assert assign_files(counts, 2) == assign_files(dict(reversed(list(counts.items()))), 2)


@pytest.mark.parametrize("raw", ["", "3", "0/3", "4/3", "a/b", "1/0", "1/2/3"])
def test_bad_shard_spec_is_rejected(raw):
    with pytest.raises(ValueError):
        parse_shard(raw)


def test_parse_ok():
    assert parse_shard("2/3") == (2, 3)


# ── ORW-193 regression: a nested pytest must not inherit the shard ─────────────────

_REPO = Path(__file__).resolve().parents[2]
_NESTED_TARGET = "frontend/tests/test_g15_gamechanged.py"


def _run_nested(env: dict) -> int:
    return subprocess.run(
        [sys.executable, "-m", "pytest", _NESTED_TARGET, "-q", "-p", "no:cacheprovider"],
        capture_output=True, text=True, cwd=_REPO, env=env,
    ).returncode


def test_nested_env_strips_every_shard_variable():
    got = nested_env({"ORWELL_CI_SHARD": "2/3", "ORWELL_CI_SHARD_X": "1", "PATH": "/bin", "ORWELL_OTHER": "1"})
    assert got == {"PATH": "/bin", "ORWELL_OTHER": "1"}


def test_nested_pytest_runs_its_target_when_wrapper_and_target_are_in_different_shards():
    # With only this one file collected, the greedy split puts it in shard 1, so "2/2" is the shard where wrapper and target differ.
    env = {**os.environ, "ORWELL_CI_SHARD": "2/2"}
    assert _run_nested(nested_env(env)) == 0


def test_unstripped_env_reproduces_the_bug():
    # DELIBERATE TRIPWIRE (negative control): this is exactly what #2223 did. If this ever stops returning 5 the regression test above no longer proves anything.
    assert _run_nested({**os.environ, "ORWELL_CI_SHARD": "2/2"}) == 5
# ── ORW-218: duration-aware balance ───────────────────────────────────────────────


def test_slow_files_are_spread_by_seconds_not_by_test_count():
    # two 1-test files that take 100 s each must NOT share a shard even though six 20-test files weigh more by count
    files = ["tests/slow_a.py", "tests/slow_b.py"] + [f"tests/many{i}.py" for i in range(6) for _ in range(20)]
    durations = {"slow_a.py": 100.0, "slow_b.py": 100.0, **{f"many{i}.py": 5.0 for i in range(6)}}
    a = select_shard(files, 1, 2, durations)
    assert ("tests/slow_a.py" in a) != ("tests/slow_b.py" in a)


def test_partition_stays_complete_with_durations():
    files = [f"tests/f{i}.py" for i in range(40) for _ in range(1 + i % 7)]
    durations = {f"f{i}.py": float((i * 37) % 90) for i in range(0, 40, 2)}  # half the files unknown
    for total in (1, 2, 3, 4):
        parts = [select_shard(files, i, total, durations) for i in range(1, total + 1)]
        assert sum(len(p) for p in parts) == len(set(files))
        assert set().union(*parts) == set(files)


def test_unknown_file_gets_the_mean_seconds_per_test_of_the_known_ones():
    counts = {"tests/known.py": 10, "tests/new.py": 4}
    w = weigh_files(counts, {"known.py": 20.0})
    assert w["tests/known.py"] == 20.0
    assert w["tests/new.py"] == pytest.approx(4 * 2.0)


def test_no_data_at_all_falls_back_to_test_count():
    counts = {"tests/a.py": 3, "tests/b.py": 1}
    assert weigh_files(counts, {}) == {"tests/a.py": 3.0, "tests/b.py": 1.0}
    assert min(weigh_files({"tests/z.py": 0}, {"z.py": 0.0}).values()) == MIN_WEIGHT


def test_stale_table_entries_are_harmless():
    files = ["tests/a.py", "tests/b.py", "tests/c.py"]
    parts = [select_shard(files, i, 2, {"gone.py": 9999.0}) for i in (1, 2)]
    assert set().union(*parts) == set(files) and not (parts[0] & parts[1])


def test_deterministic_with_durations():
    counts = {"tests/b.py": 3, "tests/a.py": 3, "tests/c.py": 1}
    d = {"a.py": 2.0, "b.py": 2.0, "c.py": 1.0}
    assert assign_files(counts, 2, d) == assign_files(dict(reversed(list(counts.items()))), 2, d)


def _real_test_files() -> list[str]:
    here = os.path.dirname(os.path.abspath(__file__))
    return sorted(n for n in os.listdir(here) if n.startswith("test_") and n.endswith(".py"))


def test_committed_table_is_valid_and_matches_the_real_test_files():
    """Hard guard over the REAL test files: no table entry for a file that is gone (refresh the table when deleting a test)."""
    table = load_durations()
    assert os.path.exists(DURATIONS_PATH) and table, "frontend/tests/_ci_durations.json must exist and be non-empty"
    assert all(isinstance(v, float) and v >= 0 for v in table.values())
    on_disk = set(_real_test_files())
    assert not (set(table) - on_disk), f"stale entries for deleted files (run tests/_ci_refresh_durations.py): {sorted(set(table) - on_disk)}"
    # A file WITHOUT an entry (a new test) is fine: it still runs and gets the explicit default weight (test count x mean seconds-per-test of the known files).
    # Refresh the table now and then (tests/_ci_refresh_durations.py); a missing entry only costs balance, never coverage.


@pytest.mark.parametrize("total", [2, 3, 4, 5])
def test_every_real_test_file_is_in_exactly_one_shard(total):
    files = [f"tests/{n}" for n in _real_test_files() for _ in range(2)]  # two collected tests per file
    parts = [select_shard(files, i, total) for i in range(1, total + 1)]  # the real committed table
    assert sum(len(p) for p in parts) == len(set(files)), "a file landed in more than one shard"
    assert set().union(*parts) == set(files), "a file landed in no shard"


@pytest.mark.parametrize("known", [True, False])
def test_a_lone_file_lands_in_shard_1_in_table_or_not(known):
    # #2266's nested-pytest tests rely on a lone collected file being in shard 1 (so "2/2" is the shard where wrapper and target differ).
    table = {"lone.py": 12.0} if known else {}
    assert select_shard(["tests/lone.py"], 1, 2, table) == {"tests/lone.py"}
    assert select_shard(["tests/lone.py"], 2, 2, table) == set()


def test_ties_go_to_the_lowest_shard():
    assert assign_files({"a": 1, "b": 1}, 2, {"a": 5.0, "b": 5.0}) == {"a": 1, "b": 2}


def test_refresh_parser_sums_setup_call_teardown_per_file():
    log = (
        "2026-11-06T13:00:00Z 12.50s call     tests/test_x.py::test_a\n"
        "2026-11-06T13:00:00Z 0.50s setup    tests/test_x.py::test_a\n"
        "2026-11-06T13:00:00Z 1.00s teardown tests/test_x.py::test_a\n"
        "2026-11-06T13:00:00Z 3.00s call     tests/test_y.py::TestK::test_b[param]\n"
        "noise 1.0s elsewhere\n"
    )
    assert parse_log(log) == {"test_x.py": 14.0, "test_y.py": 3.0}


def test_every_browser_test_file_has_a_measured_duration():
    """ORW-390: a browser file with no entry in _ci_durations.json is weighed as test count x mean seconds-per-test, which badly underweighs the slow
    real-stack files; 21 such files piled into one shard (fe-browser-tests 5/5: 13-14 min against 4-9 for the rest, cancelled at the 15 min limit).
    ORW-413: it FAILS only for a file this change adds (compared with the base: the merge ref's first parent in CI). A file main gained meanwhile (the PR is not at fault, and
    the guard and the file landed a minute apart on 2026-11-15, turning main red) only WARNS in the job summary; the splitter weighs it at 15 s per test until the table is refreshed."""
    from conftest import _module_launches_browser  # the same structural rule that adds the `browser` marker
    here = os.path.dirname(os.path.abspath(__file__))
    table = load_durations()
    missing = [n for n in _real_test_files() if _module_launches_browser(os.path.join(here, n)) and n not in table]
    must_fail, warn_only = classify_missing(missing, files_added_by_this_change(os.path.dirname(here)))
    if warn_only:
        msg = f"browser test file(s) with no entry in frontend/tests/_ci_durations.json (added by main, not by this change; weighed at 15 s per test): {warn_only}. Refresh the table."
        print(f"::warning::{msg}")
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as fh:
                fh.write(f"### Duration table warning\n{msg}\n")
    assert not must_fail, (
        f"browser test file(s) this change adds with no entry in frontend/tests/_ci_durations.json: {must_fail}. Unweighed files make fe-browser-tests shards lopsided. "
        "A brand-new file is in no main log yet: add `\"<file name>\": <seconds>` to frontend/tests/_ci_durations.json by hand (a conservative 15 per test is fine) "
        "and let the next refresh replace it with the measured time (`python3 frontend/tests/_ci_refresh_durations.py leg-1.log ... leg-10.log`, the `gh api repos/Psychout-Media/orwell/actions/jobs/<job id>/logs` of the fe-browser-tests jobs of a green main run)."
    )


def test_missing_duration_fails_only_for_a_file_this_change_adds():
    assert classify_missing(["a.py", "b.py"], {"a.py"}) == (["a.py"], ["b.py"])
    assert classify_missing(["a.py"], set()) == ([], ["a.py"])
    assert classify_missing(["a.py"], None) == (["a.py"], [])  # base unknown: fail closed


def test_unknown_browser_file_weighs_15_seconds_per_test():
    durations = {"known.py": 4.0}
    w = weigh_files({"known.py": 2, "new_browser.py": 3, "new_unit.py": 3}, durations, frozenset({"new_browser.py"}))
    assert w["new_browser.py"] == 45.0
    assert w["new_unit.py"] == 6.0  # the table's mean (4 s / 2 tests) x 3
    assert w["known.py"] == 4.0


def test_files_added_by_this_change_in_a_real_repo(tmp_path):
    def git(*a):
        subprocess.run(["git", "-C", str(tmp_path), "-c", "user.email=t@t", "-c", "user.name=t", *a], check=True, capture_output=True)

    (tmp_path / "frontend" / "tests").mkdir(parents=True)
    t = tmp_path / "frontend" / "tests"
    git("init", "-q", "-b", "main")
    (t / "test_old.py").write_text("")
    git("add", "-A"); git("commit", "-qm", "base")
    git("checkout", "-qb", "pr")
    (t / "test_pr_adds.py").write_text("")
    git("add", "-A"); git("commit", "-qm", "pr")
    git("checkout", "-q", "main")
    (t / "test_main_adds.py").write_text("")
    git("add", "-A"); git("commit", "-qm", "main moves")
    git("checkout", "-q", "pr")
    git("merge", "-q", "--no-ff", "-m", "merge ref", "main")  # what CI checks out: parent 1 = the PR head, parent 2 = main in a local merge; CI's merge ref has parent 1 = main
    # In this local merge the first parent is the PR head, so the PR's own file is not "added"; build the CI shape: main first.
    git("checkout", "-q", "main")
    git("merge", "-q", "--no-ff", "-m", "ci merge ref", "pr")
    added = files_added_by_this_change(str(tmp_path))
    assert added == {"test_pr_adds.py"}, added  # main's own test_main_adds.py is NOT this change's
    # a single-parent HEAD with no origin/main (a push to main): the commit is its own change
    git("checkout", "-q", "-b", "push", "pr~0")
    assert files_added_by_this_change(str(tmp_path)) is not None

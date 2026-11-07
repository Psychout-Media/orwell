"""ORW-193: the CI shard partition is disjoint, complete, balanced and deterministic."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from _ci_refresh_durations import parse_log
from _ci_shard import DURATIONS_PATH, MIN_WEIGHT, assign_files, load_durations, nested_env, parse_shard, select_shard, weigh_files


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

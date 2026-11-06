"""ORW-193: the CI shard partition is disjoint, complete, balanced and deterministic."""
import pytest

from _ci_shard import assign_files, parse_shard, select_shard


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
import os
import subprocess
import sys
from pathlib import Path

from _ci_shard import nested_env

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


@pytest.mark.parametrize("shard", ["1/2", "2/2"])
def test_nested_pytest_runs_its_target_whichever_shard_the_wrapper_is_in(shard):
    # With only this one file collected, the greedy split puts it in shard 1, so "2/2" is the shard where wrapper and target differ.
    env = {**os.environ, "ORWELL_CI_SHARD": shard}
    assert _run_nested(nested_env(env)) == 0


def test_unstripped_env_reproduces_the_bug():
    # Negative control: this is exactly what #2223 did. If this ever stops returning 5 the regression test above no longer proves anything.
    assert _run_nested({**os.environ, "ORWELL_CI_SHARD": "2/2"}) == 5

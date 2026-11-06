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

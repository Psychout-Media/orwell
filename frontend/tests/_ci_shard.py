"""CI lane sharding (ORW-193). Splits one pytest lane across parallel CI jobs by TEST FILE.

conftest.py wires `select_shard` into `pytest_collection_modifyitems`, gated on ORWELL_CI_SHARD="<i>/<n>" (1-based; unset = run everything, the
developer default). Whole files stay together (module-level fixtures and fixed-port servers never straddle jobs). Files are balanced greedily by
collected test count (largest first, ties by name), a deterministic function of the collected items, so every xdist worker and every shard job agrees.
The sharded items are deselected (not skipped), so the A41 skip guard still sees 0 skips per shard. Every file lands in exactly one shard
(unit-tested in test_ci_shard.py)."""
from __future__ import annotations

from collections import Counter
from typing import Sequence


def parse_shard(raw: str) -> tuple[int, int]:
    try:
        left, right = raw.split("/")
        idx, total = int(left), int(right)
    except ValueError as exc:
        raise ValueError(f"ORWELL_CI_SHARD must look like '2/3', got {raw!r}") from exc
    if total < 1 or not 1 <= idx <= total:
        raise ValueError(f"ORWELL_CI_SHARD out of range: {raw!r}")
    return idx, total


def assign_files(file_counts: dict[str, int], total: int) -> dict[str, int]:
    """file -> 1-based shard, greedy largest-first onto the lightest shard (stable)."""
    load = [0] * total
    out: dict[str, int] = {}
    for f, n in sorted(file_counts.items(), key=lambda kv: (-kv[1], kv[0])):
        k = min(range(total), key=lambda i: (load[i], i))
        load[k] += n
        out[f] = k + 1
    return out


def select_shard(files_in_order: Sequence[str], idx: int, total: int) -> set[str]:
    """The set of files that belong to shard `idx` of `total`, given each collected item's file (one entry per test)."""
    assignment = assign_files(dict(Counter(files_in_order)), total)
    return {f for f, k in assignment.items() if k == idx}

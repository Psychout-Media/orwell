"""CI lane sharding (ORW-193, balanced by measured duration in ORW-218). Splits one pytest lane across parallel CI jobs by TEST FILE.

conftest.py wires `select_shard` into `pytest_collection_modifyitems`, gated on ORWELL_CI_SHARD="<i>/<n>" (1-based; unset = run everything, the
developer default). Whole files stay together (module-level fixtures and fixed-port servers never straddle jobs). Files are balanced greedily by
MEASURED duration (largest first, ties by name) from the committed table `_ci_durations.json` (file name -> seconds, regenerate with
`python3 frontend/tests/_ci_refresh_durations.py <pytest --durations=0 logs>`). A file not in the table (new test) weighs its test count times the
mean seconds-per-test of the table's files in the same collection, so a new file still lands sensibly; with no known file in the collection it falls
back to the plain test count. The result is a deterministic function of the collected items and the table, so every xdist worker and every shard job
agrees. The table is only a balancing hint: a stale entry changes how long a shard takes, never which tests run.
The sharded items are deselected (not skipped), so the A41 skip guard still sees 0 skips per shard. Every file lands in exactly one shard
(unit-tested in test_ci_shard.py)."""
from __future__ import annotations

import json
import os
from collections import Counter
from typing import Mapping, Optional, Sequence

DURATIONS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_ci_durations.json")
MIN_WEIGHT = 0.05  # seconds: a file never weighs nothing (collection + import cost)


def load_durations(path: str = DURATIONS_PATH) -> dict[str, float]:
    try:
        with open(path, encoding="utf-8") as fh:
            return {str(k): float(v) for k, v in json.load(fh).items()}
    except FileNotFoundError:
        return {}


def weigh_files(file_counts: Mapping[str, int], durations: Mapping[str, float]) -> dict[str, float]:
    """file -> weight. Known files use their measured seconds; unknown ones n_tests * mean seconds-per-test of the known files here."""
    key = os.path.basename
    known = {f: durations[key(f)] for f in file_counts if key(f) in durations}
    known_tests = sum(file_counts[f] for f in known)
    per_test = (sum(known.values()) / known_tests) if known_tests else 1.0  # no data at all: weight == test count
    return {f: max(MIN_WEIGHT, known[f] if f in known else file_counts[f] * per_test) for f in file_counts}


def parse_shard(raw: str) -> tuple[int, int]:
    try:
        left, right = raw.split("/")
        idx, total = int(left), int(right)
    except ValueError as exc:
        raise ValueError(f"ORWELL_CI_SHARD must look like '2/3', got {raw!r}") from exc
    if total < 1 or not 1 <= idx <= total:
        raise ValueError(f"ORWELL_CI_SHARD out of range: {raw!r}")
    return idx, total


def assign_files(file_counts: dict[str, int], total: int, durations: Optional[Mapping[str, float]] = None) -> dict[str, int]:
    """file -> 1-based shard, greedy largest-first onto the lightest shard (stable). `durations` None loads the committed table."""
    weights = weigh_files(file_counts, load_durations() if durations is None else durations)
    load = [0.0] * total
    out: dict[str, int] = {}
    for f, n in sorted(weights.items(), key=lambda kv: (-kv[1], kv[0])):
        k = min(range(total), key=lambda i: (load[i], i))
        load[k] += n
        out[f] = k + 1
    return out


def select_shard(files_in_order: Sequence[str], idx: int, total: int, durations: Optional[Mapping[str, float]] = None) -> set[str]:
    """The set of files that belong to shard `idx` of `total`, given each collected item's file (one entry per test)."""
    assignment = assign_files(dict(Counter(files_in_order)), total, durations)
    return {f for f, k in assignment.items() if k == idx}


SHARD_ENV_PREFIX = "ORWELL_CI_SHARD"


def nested_env(env: Mapping[str, str]) -> dict[str, str]:
    """A copy of `env` without any shard variable. Pass it to every test that launches pytest as a subprocess: the child is a separate session over
    its own target file, and an inherited ORWELL_CI_SHARD makes it deselect that file (0 tests collected, exit 5) whenever the wrapper and the target
    sit in different shards (ORW-193 regression)."""
    return {k: v for k, v in env.items() if not k.startswith(SHARD_ENV_PREFIX)}

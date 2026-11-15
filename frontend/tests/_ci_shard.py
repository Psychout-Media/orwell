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
BROWSER_DEFAULT_SECONDS_PER_TEST = 15.0  # ORW-413: a browser file with no measured entry weighs 15 s per test (real-stack tests are slow; the mean of the table underweighs them)


def load_durations(path: str = DURATIONS_PATH) -> dict[str, float]:
    try:
        with open(path, encoding="utf-8") as fh:
            return {str(k): float(v) for k, v in json.load(fh).items()}
    except FileNotFoundError:
        return {}


def weigh_files(file_counts: Mapping[str, int], durations: Mapping[str, float], browser_files: frozenset[str] = frozenset()) -> dict[str, float]:
    """file -> weight. Known files use their measured seconds; unknown ones n_tests * mean seconds-per-test of the known files here, or n_tests * 15 s for an unknown
    BROWSER file (`browser_files`, ORW-413)."""
    key = os.path.basename
    known = {f: durations[key(f)] for f in file_counts if key(f) in durations}
    known_tests = sum(file_counts[f] for f in known)
    per_test = (sum(known.values()) / known_tests) if known_tests else 1.0  # no data at all: weight == test count
    return {f: max(MIN_WEIGHT, known[f] if f in known else file_counts[f] * (BROWSER_DEFAULT_SECONDS_PER_TEST if f in browser_files else per_test)) for f in file_counts}


def parse_shard(raw: str) -> tuple[int, int]:
    try:
        left, right = raw.split("/")
        idx, total = int(left), int(right)
    except ValueError as exc:
        raise ValueError(f"ORWELL_CI_SHARD must look like '2/3', got {raw!r}") from exc
    if total < 1 or not 1 <= idx <= total:
        raise ValueError(f"ORWELL_CI_SHARD out of range: {raw!r}")
    return idx, total


def assign_files(file_counts: dict[str, int], total: int, durations: Optional[Mapping[str, float]] = None, browser_files: frozenset[str] = frozenset()) -> dict[str, int]:
    """file -> 1-based shard, greedy largest-first onto the lightest shard (stable). `durations` None loads the committed table."""
    weights = weigh_files(file_counts, load_durations() if durations is None else durations, browser_files)
    load = [0.0] * total
    out: dict[str, int] = {}
    for f, n in sorted(weights.items(), key=lambda kv: (-kv[1], kv[0])):
        k = min(range(total), key=lambda i: (load[i], i))
        load[k] += n
        out[f] = k + 1
    return out


def select_shard(files_in_order: Sequence[str], idx: int, total: int, durations: Optional[Mapping[str, float]] = None, browser_files: frozenset[str] = frozenset()) -> set[str]:
    """The set of files that belong to shard `idx` of `total`, given each collected item's file (one entry per test)."""
    assignment = assign_files(dict(Counter(files_in_order)), total, durations, browser_files)
    return {f for f, k in assignment.items() if k == idx}


SHARD_ENV_PREFIX = "ORWELL_CI_SHARD"


def nested_env(env: Mapping[str, str]) -> dict[str, str]:
    """A copy of `env` without any shard variable. Pass it to every test that launches pytest as a subprocess: the child is a separate session over
    its own target file, and an inherited ORWELL_CI_SHARD makes it deselect that file (0 tests collected, exit 5) whenever the wrapper and the target
    sit in different shards (ORW-193 regression)."""
    return {k: v for k, v in env.items() if not k.startswith(SHARD_ENV_PREFIX)}


def files_added_by_this_change(repo_root: str, rel_dir: str = "frontend/tests") -> Optional[set[str]]:
    """ORW-413: the test file names under `rel_dir` that THIS change adds, i.e. present at HEAD and absent at the base. None when the base cannot be found (callers fail closed).
    The base is, in order: the first parent when HEAD is a merge commit (CI checks out the PR merged into main, so parent 1 is main: a file main gained on its own is not
    "added by the PR"); else the merge base with origin/main when that is an older commit (a developer checkout); else the single parent (a push to main: the commit is its own change)."""
    import subprocess

    def git(*args: str) -> Optional[str]:
        r = subprocess.run(["git", "-C", repo_root, *args], capture_output=True, text=True)
        return r.stdout.strip() if r.returncode == 0 else None

    head = git("rev-parse", "HEAD")
    if head is None:
        return None
    parents = (git("rev-list", "--parents", "-n", "1", "HEAD") or "").split()[1:]
    base = parents[0] if len(parents) >= 2 else None
    if base is None:
        mb = git("merge-base", "HEAD", "origin/main")
        base = mb if mb and mb != head else (parents[0] if parents else None)
    if base is None:
        return None
    at = lambda rev: git("ls-tree", "--name-only", rev, rel_dir.rstrip("/") + "/")
    now, then = at("HEAD"), at(base)
    if now is None or then is None:
        return None
    names = lambda out: {os.path.basename(x) for x in out.splitlines()}
    return names(now) - names(then)


def classify_missing(missing: Sequence[str], added: Optional[set[str]]) -> tuple[list[str], list[str]]:
    """(must_fail, warn_only). A file with no measured duration fails only when this change adds it (or the base is unknown); a file main gained meanwhile only warns."""
    if added is None:
        return list(missing), []
    return [m for m in missing if m in added], [m for m in missing if m not in added]

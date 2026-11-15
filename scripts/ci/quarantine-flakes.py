#!/usr/bin/env python3
"""quarantine-flakes.py: which tests flaked on main, and the patch to quarantine them (ORW-415). Read-only: it changes nothing.

Reads the flaky-test lines the lanes already write into their job logs (frontend/tests/_flaky_report.py for pytest, tests/support/flakyReporter.ts for
vitest, the mirror gates' warnings: a test that failed, then passed on the automatic retry) from the last N completed CI runs on main, and prints per
flaky test how many runs it flaked in, then the patch that would add it to frontend/tests/_quarantine.py's marker (docs/CI.md, rule 3).
Apply a patch yourself after opening the Plane card and reading it (replace ORW-NNN with the card). A flake is quarantined the day it is seen and gets a card.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import difflib
import json
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ci_logparse import parse_flakes  # noqa: E402

SKIP_JOBS = re.compile(r"^(changes|ci-gate|coverage|fe-coverage|heavy-sims.*)$")  # no retries there, or no tests
REPO_ROOT = Path(__file__).resolve().parents[2]


def gh(*args: str) -> str:
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout


def gh_log(repo: str, job_id: int) -> str:
    try:
        return gh("api", f"repos/{repo}/actions/jobs/{job_id}/logs")
    except subprocess.CalledProcessError:
        return ""


def main_runs(repo: str, n: int) -> list[dict]:
    out = gh("run", "list", "-R", repo, "--branch", "main", "--workflow", "CI", "--status", "completed", "--limit", str(max(n * 4, 50)),
             "--json", "databaseId,conclusion,createdAt,headSha")
    runs = [r for r in json.loads(out) if r["conclusion"] in ("success", "failure")]
    return sorted(runs, key=lambda r: r["createdAt"], reverse=True)[:n]


def run_flakes(repo: str, run: dict) -> list[tuple[str, str]]:
    """[(job name, test id)] for one run."""
    jobs = json.loads(gh("run", "view", str(run["databaseId"]), "-R", repo, "--json", "jobs"))["jobs"]
    todo = [j for j in jobs if j["conclusion"] in ("success", "failure") and not SKIP_JOBS.match(j["name"])]
    found: list[tuple[str, str]] = []
    for j in todo:
        for tid in parse_flakes(gh_log(repo, j["databaseId"])):
            found.append((j["name"], tid))
    return found


def aggregate(per_run: dict[int, list[tuple[str, str]]]) -> dict[str, dict]:
    agg: dict[str, dict] = defaultdict(lambda: {"runs": set(), "jobs": set()})
    for rid, rows in per_run.items():
        for job, tid in rows:
            agg[tid]["runs"].add(rid)
            agg[tid]["jobs"].add(job)
    return agg


def locate_pytest(tid: str, root: Path = REPO_ROOT) -> tuple[Path, int] | None:
    """(file, 0-based line of the def) for a pytest node id like tests/test_x.py::test_name[param] or ::Class::test_name."""
    m = re.match(r"^(?P<file>[^:\s]+\.py)::(?P<rest>.+)$", tid)
    if not m:
        return None
    name = m.group("rest").split("::")[-1].split("[")[0]
    path = root / "frontend" / m.group("file")
    if not path.is_file():
        return None
    for i, line in enumerate(path.read_text(encoding="utf-8").splitlines()):
        if re.match(rf"^\s*(async\s+)?def {re.escape(name)}\(", line):
            return path, i
    return None


def pytest_patch(tid: str, card: str, today: str, root: Path = REPO_ROOT) -> str | None:
    """A unified diff adding the quarantine marker above the test, or None when the test cannot be located."""
    loc = locate_pytest(tid, root)
    if not loc:
        return None
    path, i = loc
    lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
    j = i
    while j > 0 and lines[j - 1].lstrip().startswith("@"):  # keep the marker with the existing decorators
        j -= 1
    indent = re.match(r"\s*", lines[i]).group(0)
    new = lines[:j] + [f'{indent}@pytest.mark.quarantine(card="{card}", added="{today}")\n'] + lines[j:]
    rel = path.relative_to(root).as_posix()
    diff = "".join(difflib.unified_diff(lines, new, f"a/{rel}", f"b/{rel}", n=3))
    if not re.search(r"^import pytest\b|^from pytest import", "".join(lines), re.M):
        diff += f"# note: {rel} does not import pytest yet; add `import pytest` at the top\n"
    return diff


def vitest_hint(tid: str, card: str, today: str) -> str:
    file, _, name = tid.partition(" > ")
    return (f"# {file}: add `import {{ quarantine }} from \"../support/quarantine\";` and change `it(\"{name.split(' > ')[-1]}\", ...)` to\n"
            f"#   quarantine({{ card: \"{card}\", added: \"{today}\" }}).it(\"{name.split(' > ')[-1]}\", ...)")


def render(agg: dict[str, dict], n_runs: int, today: str, root: Path = REPO_ROOT) -> str:
    if not agg:
        return f"No test passed only on a retry in the last {n_runs} completed main runs.\n"
    out = [f"{len(agg)} flaky test(s) in the last {n_runs} completed main runs (a flake = failed, then passed on the automatic retry):\n"]
    for tid, d in sorted(agg.items(), key=lambda kv: (-len(kv[1]["runs"]), kv[0])):
        out.append(f"  {len(d['runs'])}/{n_runs} runs  {tid}\n      lanes: {', '.join(sorted(d['jobs']))}\n      runs: {', '.join(str(r) for r in sorted(d['runs'], reverse=True))}")
    out.append("\nPatches to quarantine them (docs/CI.md, rule 3: open the Plane card first, replace ORW-NNN with its number; review before applying):\n")
    for tid in sorted(agg):
        if "::" in tid and ".py" in tid:
            patch = pytest_patch(tid, "ORW-NNN", today, root)
            out.append(patch if patch else f"# {tid}: could not locate the test under frontend/; mark it by hand\n")
        elif " > " in tid and ".ts" in tid:
            out.append(vitest_hint(tid, "ORW-NNN", today) + "\n")
        else:
            out.append(f"# {tid}: a gate with its own attempt loop (not a test); fix it, there is nothing to mark\n")
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--runs", type=int, default=20, help="how many of the newest completed CI runs on main to read (default 20)")
    ap.add_argument("--repo", default="Psychout-Media/orwell")
    ap.add_argument("--workers", type=int, default=4, help="parallel run readers (default 4; keep it low, GitHub rate-limits bursts)")
    a = ap.parse_args()
    runs = main_runs(a.repo, a.runs)
    print(f"reading {len(runs)} completed main runs, newest {runs[0]['databaseId'] if runs else '-'} ...", file=sys.stderr)
    per_run: dict[int, list[tuple[str, str]]] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers) as ex:
        for run, rows in zip(runs, ex.map(lambda r: run_flakes(a.repo, r), runs)):
            per_run[run["databaseId"]] = rows
    print(render(aggregate(per_run), len(runs), dt.datetime.now(dt.timezone.utc).date().isoformat()))
    return 0


if __name__ == "__main__":
    sys.exit(main())

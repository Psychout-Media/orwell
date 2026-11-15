#!/usr/bin/env python3
"""Front-end coverage floor check (ORW-218: "test coverage holds and rises").

usage: check-fe-coverage.py <coverage.json> <coverage_floor.json>

<coverage.json> is `coverage json` output (the fe-coverage job combines the fe-unit shards' data files first). The floor file maps a
directory (first path component under frontend/; "(root)" = top-level files such as app.py; "TOTAL" = everything) to {"line": N, "branch": N}
percentages. Exit 1 when any directory is below its floor for line or branch coverage, or is missing from the measurement (a renamed or deleted
directory must update the floor file deliberately, never silently drop out of the gate). When a measurement exceeds its floor by RATCHET_MARGIN
points or more it prints "ratchet up: raise <dir> <kind> floor to N" (N = measured, rounded down by 1 point) and still exits 0.
"""
from __future__ import annotations

import json
import math
import sys

RATCHET_MARGIN = 2.0
KINDS = (("line", "covered_lines", "num_statements"), ("branch", "covered_branches", "num_branches"))


def group(report: dict) -> dict[str, dict[str, int]]:
    """Per-directory sums of covered/total lines and branches, plus TOTAL."""
    out: dict[str, dict[str, int]] = {}
    for path, data in report.get("files", {}).items():
        parts = path.replace("\\", "/").split("/")
        key = parts[0] if len(parts) > 1 else "(root)"
        s = data["summary"]
        for k in (key, "TOTAL"):
            acc = out.setdefault(k, {f: 0 for _, c, t in KINDS for f in (c, t)})
            for _, c, t in KINDS:
                acc[c] += s.get(c, 0)
                acc[t] += s.get(t, 0)
    return out


def pct(acc: dict[str, int], covered: str, total: str) -> float:
    return 100.0 if acc[total] == 0 else 100.0 * acc[covered] / acc[total]


def check(report: dict, floors: dict) -> tuple[list[str], list[str], list[str]]:
    """-> (failures, ratchet hints, table rows)."""
    measured = group(report)
    fails: list[str] = []
    hints: list[str] = []
    rows: list[str] = []
    for name, want in floors.items():
        acc = measured.get(name)
        if acc is None:
            fails.append(f"{name}: not in the coverage measurement (renamed or removed? update frontend/coverage_floor.json deliberately)")
            continue
        for kind, c, t in KINDS:
            if kind not in want:
                continue
            got, floor = pct(acc, c, t), float(want[kind])
            rows.append(f"{name:<14} {kind:<6} measured {got:6.2f}  floor {floor:6.2f}")
            if got < floor:
                fails.append(f"{name}: {kind} coverage {got:.2f}% is below the floor {floor:.2f}%")
            elif got - floor >= RATCHET_MARGIN:
                hints.append(f"ratchet up: raise {name} {kind} floor to {math.floor(got) - 1} (measured {got:.2f}%, floor {floor:.2f}%)")
    return fails, hints, rows


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__)
        return 2
    with open(argv[1], encoding="utf-8") as fh:
        report = json.load(fh)
    with open(argv[2], encoding="utf-8") as fh:
        floors = {k: v for k, v in json.load(fh).items() if not k.startswith("_")}
    fails, hints, rows = check(report, floors)
    print("\n".join(rows))
    for h in hints:
        print(h)
    for f in fails:
        print(f"::error::{f}")
    print("fe-coverage: FAIL" if fails else "fe-coverage: PASS")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

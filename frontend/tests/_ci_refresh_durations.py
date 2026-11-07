"""ORW-218: regenerate _ci_durations.json from the logs of green CI runs of the FE lanes (fe-unit and fe-browser-tests). Both lanes run with
`--durations=0` (ci.yml, ORW-229), so their logs carry every test's time; a log without those lines (a local run without the flag) only refreshes
the files it shows.

    gh api repos/<owner>/<repo>/actions/jobs/<job id>/logs > leg.log        (one per fe-unit / fe-browser-tests shard job: 2 + 5 logs)
    python3 frontend/tests/_ci_refresh_durations.py leg-1.log leg-2.log ...

Sums the setup + call + teardown seconds of every test per file (reruns included) and merges them over the existing table (files not seen keep their old value).
Also (a) drops entries for files that no longer exist (the completeness guard in test_ci_shard.py fails on those) and (b) gives every test file on disk that did not appear
in the logs a tiny weight (FAST_FILE_SECONDS): pytest hides tests under 5 ms, so a file with no timing line is a fast file, not an unknown one.
The table is a balancing hint only (see _ci_shard.py)."""
from __future__ import annotations

import json
import os
import re
import sys
from collections import defaultdict

FAST_FILE_SECONDS = 0.1
LINE = re.compile(r"(?P<sec>\d+(?:\.\d+)?)s (?:call|setup|teardown)\s+(?:frontend/)?tests/(?P<file>[\w.\-]+\.py)::")


def parse_log(text: str) -> dict[str, float]:
    total: dict[str, float] = defaultdict(float)
    for line in text.splitlines():
        m = LINE.search(line)
        if m:
            total[m.group("file")] += float(m.group("sec"))
    return {k: round(v, 2) for k, v in total.items()}


def main(paths: list[str]) -> int:
    table_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_ci_durations.json")
    table: dict[str, float] = {}
    if os.path.exists(table_path):
        with open(table_path, encoding="utf-8") as fh:
            table = json.load(fh)
    seen = 0
    for p in paths:
        with open(p, encoding="utf-8", errors="replace") as fh:
            got = parse_log(fh.read())
        table.update(got)
        seen += len(got)
    here = os.path.dirname(os.path.abspath(__file__))
    on_disk = {n for n in os.listdir(here) if n.startswith("test_") and n.endswith(".py")}
    table = {k: v for k, v in table.items() if k in on_disk}
    for n in on_disk:
        table.setdefault(n, FAST_FILE_SECONDS)
    with open(table_path, "w", encoding="utf-8") as fh:
        json.dump(dict(sorted(table.items())), fh, indent=1)
        fh.write("\n")
    print(f"updated {seen} entries; {len(table)} in the table")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

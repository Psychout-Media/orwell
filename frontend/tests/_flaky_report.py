"""ORW-229 flaky-test rule (docs/CI.md): count the flakes that `--reruns 1` would otherwise hide.

CI reruns a failed front-end test once (pytest-rerunfailures: `--reruns 1` in fe-unit and fe-browser-tests). A test that fails and then passes on the
rerun is a FLAKE: this plugin lists every such test (and every test still red after its rerun) in the terminal summary, as a GitHub warning
annotation, and in the GitHub job summary ($GITHUB_STEP_SUMMARY), so flakes are counted, not hidden. conftest.py registers it; it reports from the
xdist controller only, which receives every worker's reports. Pinned by test_ci_flaky_report.py."""
from __future__ import annotations

import os
from collections import Counter


def flakes(stats: dict) -> tuple[list[tuple[str, int]], list[tuple[str, int]]]:
    """(flaky, still_red) from a terminal reporter's stats: [(nodeid, reruns)]. Flaky = rerun at least once, then passed; still red = rerun, then failed."""
    reruns = Counter(r.nodeid for r in stats.get("rerun", []))
    passed = {r.nodeid for r in stats.get("passed", []) if getattr(r, "when", "call") == "call"}
    failed = {r.nodeid for key in ("failed", "error") for r in stats.get(key, [])}
    flaky = sorted((n, c) for n, c in reruns.items() if n in passed and n not in failed)
    still_red = sorted((n, c) for n, c in reruns.items() if n in failed)
    return flaky, still_red


def summary_markdown(flaky: list[tuple[str, int]], still_red: list[tuple[str, int]], lane: str) -> str:
    if not flaky and not still_red:
        return ""
    md = f"### Flaky tests (pytest{', ' + lane if lane else ''})\n\n"
    if flaky:
        md += (f"**{len(flaky)} test(s) failed, then passed on the automatic rerun.** Each is a flake: fix it, or quarantine it with a Plane card "
               "(docs/CI.md).\n\n| test | reruns |\n|---|---|\n" + "".join(f"| {n.replace('|', chr(92) + '|')} | {c} |\n" for n, c in flaky) + "\n")
    if still_red:
        md += (f"**{len(still_red)} test(s) were still red after the rerun** (a real failure, or a hard flake).\n\n"
               + "".join(f"- {n}\n" for n, _ in still_red) + "\n")
    return md


def pytest_terminal_summary(terminalreporter, exitstatus, config) -> None:
    if hasattr(config, "workerinput"):
        return
    flaky, still_red = flakes(terminalreporter.stats)
    terminalreporter.write_sep("=", f"flaky tests (ORW-229): {len(flaky)} passed only on a rerun, {len(still_red)} still red after a rerun")
    for nodeid, n in flaky:
        terminalreporter.write_line(f"  FLAKY (passed on rerun {n}): {nodeid}")
        terminalreporter.write_line(f"::warning title=Flaky test (passed on rerun)::{nodeid}")
    md = summary_markdown(flaky, still_red, os.environ.get("ORWELL_SKIP_LANE", ""))
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if md and summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(md)

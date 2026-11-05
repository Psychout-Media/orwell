"""A41 - the silent-skip guard. ~270 `pytest.skip`/`skipif` calls in this suite quietly skip when playwright, chromium or node is missing, so a lane can go green while the tests that matter never ran.
This module is the PURE evaluator (unit-tested in test_a41_skip_guard.py); conftest.py wires it into `pytest_sessionfinish`, gated on ORWELL_SKIP_GUARD=1 (CI sets it; a developer laptop without chromium is
not punished). Two rules:
  1. MUST-RUN: in the `browser` lane every collected test must run - any browser test that skipped is a violation (the lane exists to run a real headless browser).
  2. CEILING: the total number of skipped tests may not exceed the recorded ceiling for the lane (skip_ceiling.json), so a new silent skip, or a missing tool turning many tests into skips, goes red.
Raising a ceiling is a deliberate, reviewed edit of skip_ceiling.json, never a side effect."""
from __future__ import annotations

from typing import Iterable, Sequence


def evaluate(skipped: Sequence[tuple[str, str]], *, lane: str, ceiling: int | None, browser_ids: Iterable[str]) -> list[str]:
    """`skipped` = [(nodeid, reason)]. Returns human-readable violations (empty = pass)."""
    out: list[str] = []
    browser = set(browser_ids)
    if lane == "browser":
        for nodeid, reason in skipped:
            if nodeid in browser:
                out.append(f"MUST-RUN browser test skipped: {nodeid} ({reason})")
    if ceiling is not None and len(skipped) > ceiling:
        out.append(f"skip count {len(skipped)} exceeds the recorded ceiling {ceiling} for lane '{lane}' (a new silent skip, or a missing tool)")
    return out

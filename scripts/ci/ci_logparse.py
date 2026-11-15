#!/usr/bin/env python3
"""Parsers for GitHub Actions job logs of the Orwell CI (ORW-415). Stdlib only.

Used by watch-pr.sh and quarantine-flakes.py. Reads a job log on stdin:

    ci_logparse.py failures [--flakes FILE]
                              -> JSON {"tests": [...], "errors": [...], "known_flake": bool}  (failing tests, the first error lines,
                                 and whether every failing test is listed in FILE: one test id per line, `#` comments)
    ci_logparse.py flakes     -> one test id per line (tests that passed only on a retry)
    ci_logparse.py --help

Formats understood (all as the lanes in .github/workflows/ci.yml print them):
  pytest   `____ test_x ____` headers in the FAILURES block, `E   ` lines, `FAILED path::test - msg` summary lines
  vitest   ` FAIL  file > suite > test` lines and `AssertionError`/`Error:` lines after them
  cucumber the `Failures:` block: `1) Scenario: name # file:line`, the first failing step and its error text
Flakes (docs/CI.md, ORW-229):
  pytest   `  FLAKY (passed on rerun N): nodeid`  and  `##[warning]nodeid`
  vitest   `##[warning]tests/unit/x.test.ts > suite > test`
  gates    `##[warning]mirror-parity (WS) passed only on attempt 2`
  (the runner prints a `::warning title=T::msg` workflow command as `##[warning]msg`.)
"""
from __future__ import annotations

import json
import re
import sys

TS = re.compile(r"^\d{4}-\d\d-\d\dT[\d:.]+Z ?")
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
PYTEST_HEADER = re.compile(r"^_{3,} (.+?) _{3,}$")
PYTEST_FAILED = re.compile(r"^(?:FAILED|ERROR) (\S+?)(?: - (.*))?$")  # an `ERROR tests/x.py::test_y - ...` summary line (a setup/teardown error) names the test like FAILED does
PYTEST_SECTION = re.compile(r"^=+ (?:FAILURES|ERRORS) =+$")
VITEST_FAIL = re.compile(r"^\s*FAIL\s+(\S.*)$")
VITEST_ERR = re.compile(r"^(\w*(?:Error|Exception)\b.*)$")
CUCUMBER_SCENARIO = re.compile(r"^\d+\) Scenario(?: Outline)?: (.*?)(?: # \S+)?$")
CUCUMBER_FAILED_STEP = re.compile(r"^\s*✖ (.*?)(?: # \S+)?$")
FLAKE_PATTERNS = (
    re.compile(r"FLAKY \(passed on rerun \d+\): (.+)$"),
    # the runner turns `::warning title=..::msg` into `##[warning]msg` in the log (the title is not printed), so match the message shapes
    re.compile(r"##\[warning\](\S+\.py::\S.*)$"),
    re.compile(r"##\[warning\](\S+\.test\.ts > .+)$"),
    re.compile(r"##\[warning\](.+ passed only on attempt \d+)$"),
)
MAX_ERRORS = 12


def clean(log: str) -> list[str]:
    """Log lines with the runner timestamp and colour codes removed."""
    return [ANSI.sub("", TS.sub("", ln)).rstrip() for ln in log.splitlines()]


def parse_failures(log: str) -> dict[str, list[str]]:
    lines = clean(log)
    tests: list[str] = []
    errors: list[str] = []

    def add_test(name: str) -> None:
        if name and name not in tests:
            tests.append(name)

    def add_err(text: str) -> None:
        text = text.strip()
        if text and text not in errors and len(errors) < MAX_ERRORS:
            errors.append(text[:300])

    in_pytest = False
    in_cucumber = False
    cuke_step_seen = False
    for i, ln in enumerate(lines):
        if PYTEST_SECTION.match(ln):  # setup/teardown errors live in the ERRORS section, headed `____ ERROR at setup of test_x ____`
            in_pytest = True
            continue
        if in_pytest and re.match(r"^=+ .* =+$", ln):
            in_pytest = False
        m = PYTEST_HEADER.match(ln)
        if m and in_pytest:
            add_test(re.sub(r"^ERROR at (?:setup|teardown) of ", "", m.group(1)))
            continue
        if in_pytest and ln.startswith("E  "):
            add_err(ln[1:])
            continue
        m = PYTEST_FAILED.match(ln)
        if m:
            add_test(m.group(1).split("::")[-1] if "::" in m.group(1) else m.group(1))
            if m.group(2):
                add_err(m.group(2))
            continue
        m = VITEST_FAIL.match(ln)
        if m and "Failed Tests" not in ln:
            add_test(m.group(1).strip())
            # the error text follows the FAIL lines; take the first Error-looking line after them
            for nxt in lines[i + 1:i + 8]:
                e = VITEST_ERR.match(nxt)
                if e:
                    add_err(e.group(1))
                    break
            continue
        if ln.strip() == "Failures:":
            in_cucumber = True
            continue
        if in_cucumber:
            m = CUCUMBER_SCENARIO.match(ln)
            if m:
                add_test(m.group(1))
                cuke_step_seen = False
                continue
            m = CUCUMBER_FAILED_STEP.match(ln)
            if m and not cuke_step_seen:
                cuke_step_seen = True
                add_err("step failed: " + m.group(1))
                for nxt in lines[i + 1:i + 4]:
                    if nxt.strip():
                        add_err(nxt)
                        break
                continue
            if re.match(r"^\d+ scenarios? \(", ln):
                in_cucumber = False
    if not tests:  # a build/setup step failed, not a test: the runner's own error annotations say why
        for ln in lines:
            if "##[error]" in ln:
                add_err(ln.split("##[error]", 1)[1])
    return {"tests": tests, "errors": errors}


def parse_flakes(log: str) -> list[str]:
    """Test ids that passed only on a retry, in order of first appearance, without duplicates."""
    out: list[str] = []
    for ln in clean(log):
        for pat in FLAKE_PATTERNS:
            m = pat.search(ln)
            if m:
                tid = m.group(1).strip()
                if tid not in out:
                    out.append(tid)
                break
    return out


def load_flakes(path: str) -> list[str]:
    try:
        with open(path, encoding="utf-8") as fh:
            rows = [ln.split("#", 1)[0].strip() for ln in fh]
    except OSError:
        return []
    return [r for r in rows if r]


def is_known_flake(test: str, known: list[str]) -> bool:
    """A failing test is a known flake when a listed id equals it or is contained in it (a bare name matches a full node id)."""
    return any(k == test or k in test for k in known)


def all_known_flakes(tests: list[str], known: list[str]) -> bool:
    return bool(tests) and all(is_known_flake(t, known) for t in tests)


def main(argv: list[str]) -> int:
    if argv and argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if not argv or argv[0] not in ("failures", "flakes"):
        print(__doc__, file=sys.stderr)
        return 64
    log = sys.stdin.read()
    if argv[0] == "failures":
        res: dict = parse_failures(log)
        known = load_flakes(argv[2]) if len(argv) == 3 and argv[1] == "--flakes" else []
        res["known_flake"] = all_known_flakes(res["tests"], known)
        print(json.dumps(res))
    elif argv[0] == "flakes":
        print("\n".join(parse_flakes(log)))
    else:
        print(__doc__, file=sys.stderr)
        return 64
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

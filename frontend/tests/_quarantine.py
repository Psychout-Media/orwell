"""ORW-229 flaky-test rule (docs/CI.md): the `quarantine` marker.

    @pytest.mark.quarantine(card="ORW-123", added="2026-11-06")
    def test_something(): ...

A quarantined test is DESELECTED (not skipped, so the A41 skip guard and its 0-skip ceilings are untouched) in every run except the nightly one
(ORWELL_RUN_QUARANTINED=1). Every quarantine must name a Plane card and an added-on date and may live at most MAX_AGE_DAYS; test_ci_quarantine_guard.py
reads them straight from the source (find_quarantines) and fails the build otherwise.

This module is a pytest plugin (conftest.py registers it): it registers the marker, deselects quarantined items inside conftest's modifyitems
wrapper (so before the ORWELL_CI_SHARD split), and lists the suite's quarantines in the terminal summary and the GitHub job summary."""
from __future__ import annotations

import ast
import datetime as _dt
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

MAX_AGE_DAYS = 7
PLANE_CARD = re.compile(r"^[A-Z][A-Z0-9]*-\d+$")
RUN_ENV = "ORWELL_RUN_QUARANTINED"
MARKER_HELP = ("quarantine(card, added): a known-flaky test parked for at most 7 days with a Plane card; deselected in PR, merge-queue and main runs, "
               "run nightly (docs/CI.md)")


@dataclass(frozen=True)
class Quarantine:
    path: str
    line: int
    target: str
    card: str | None
    added: str | None


def _dotted(node: ast.AST) -> str:
    if isinstance(node, ast.Attribute):
        return f"{_dotted(node.value)}.{node.attr}"
    if isinstance(node, ast.Name):
        return node.id
    return ""


def _is_marker(node: ast.AST) -> bool:
    return _dotted(node).endswith("mark.quarantine")


def find_quarantines(source: str, path: str) -> list[Quarantine]:
    """Every use of the quarantine marker in a test module: decorators, `pytestmark`, `pytest.param(marks=...)`; a bare (uncalled) marker counts too."""
    tree = ast.parse(source)
    targets: dict[int, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            for dec in node.decorator_list:
                targets[id(dec)] = node.name
    found: list[Quarantine] = []
    called: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and _is_marker(node.func):
            called.add(id(node.func))
            kw = {k.arg: k.value for k in node.keywords if k.arg}
            def text(key: str) -> str | None:
                v = kw.get(key)
                return v.value if isinstance(v, ast.Constant) and isinstance(v.value, str) else None
            found.append(Quarantine(path, node.lineno, targets.get(id(node), "<module or param>"), text("card"), text("added")))
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and _is_marker(node) and id(node) not in called:
            found.append(Quarantine(path, node.lineno, targets.get(id(node), "<module or param>"), None, None))
    return sorted(found, key=lambda q: q.line)


def scan(paths: Iterable[str | Path], root: str | Path) -> list[Quarantine]:
    """Every quarantine in the test files under `paths` (files or directories), with paths relative to `root` (like pytest node ids)."""
    root = Path(root).resolve()
    files: set[Path] = set()
    for raw in paths:
        p = Path(raw).resolve()
        files.update(p.rglob("*.py") if p.is_dir() else [p] if p.suffix == ".py" and p.exists() else [])
    out: list[Quarantine] = []
    for p in sorted(files):
        if p.name in {"_quarantine.py", "test_ci_quarantine_guard.py"} or "vendor" in p.parts:
            continue
        src = p.read_text(encoding="utf-8", errors="ignore")
        if "quarantine" in src:
            try:
                rel = str(p.relative_to(root))
            except ValueError:
                rel = str(p)
            out.extend(find_quarantines(src, rel))
    return out


def problems(q: Quarantine, today: _dt.date) -> list[str]:
    """The ways one quarantine breaks the rule on `today` (UTC). Empty = it follows the rule."""
    where = f"{q.path}:{q.line} ({q.target})"
    if q.card is None or q.added is None:
        return [f"{where}: write it as @pytest.mark.quarantine(card=\"ORW-123\", added=\"YYYY-MM-DD\") with literal strings so the card and date can be checked"]
    out: list[str] = []
    if not PLANE_CARD.match(q.card):
        out.append(f"{where}: {q.card!r} is not a Plane card id (like ORW-123)")
    try:
        added = _dt.date.fromisoformat(q.added) if re.fullmatch(r"\d{4}-\d{2}-\d{2}", q.added) else None
    except ValueError:
        added = None
    if added is None:
        out.append(f"{where}: added {q.added!r} is not a date (YYYY-MM-DD)")
        return out
    age = (today - added).days
    if age < -1:
        out.append(f"{where}: added {q.added} is in the future")
    if age > MAX_AGE_DAYS:
        out.append(f"{where}: quarantined {age} days ago ({q.added}, {q.card}); the rule allows {MAX_AGE_DAYS}. "
                   "Fix the test and remove the quarantine, or delete the test.")
    return out


def split_quarantined(items: Iterable, run_quarantined: bool) -> tuple[list, list]:
    """(kept, parked): with run_quarantined False every item carrying the marker is parked (to be deselected)."""
    kept, parked = [], []
    for item in items:
        (parked if (not run_quarantined and item.get_closest_marker("quarantine")) else kept).append(item)
    return kept, parked


def summary_lines(found: list[Quarantine], today: _dt.date) -> list[str]:
    lines = []
    for q in found:
        try:
            left = MAX_AGE_DAYS - (today - _dt.date.fromisoformat(q.added or "")).days
            when = f"since {q.added}, {left} day(s) left"
        except ValueError:
            when = f"added {q.added!r}"
        lines.append(f"{q.card or '(no card)'}: {q.path}::{q.target} ({when})")
    return lines


# ── pytest plugin hooks ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
def pytest_configure(config) -> None:
    config.addinivalue_line("markers", MARKER_HELP)


def pytest_collection_modifyitems(config, items) -> None:
    kept, parked = split_quarantined(items, os.environ.get(RUN_ENV) == "1")
    if parked:
        config.hook.pytest_deselected(items=parked)
        items[:] = kept


def pytest_terminal_summary(terminalreporter, exitstatus, config) -> None:
    if hasattr(config, "workerinput"):
        return
    found = scan([a.split("::")[0] for a in config.args], config.rootpath)
    if not found:
        return
    today = _dt.datetime.now(_dt.timezone.utc).date()
    ran = os.environ.get(RUN_ENV) == "1"
    head = f"{len(found)} quarantined test(s) " + ("RAN in this run (nightly)" if ran else "deselected here; they run in the nightly workflow")
    terminalreporter.write_sep("=", f"quarantine (ORW-229): {head}")
    lines = summary_lines(found, today)
    for line in lines:
        terminalreporter.write_line(f"  {line}")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(f"### Quarantined tests (pytest)\n\n{head}:\n\n" + "".join(f"- {line}\n" for line in lines) + "\n")

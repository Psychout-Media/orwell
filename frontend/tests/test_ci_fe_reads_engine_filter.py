"""ORW-218 - the CI path filter must run fe-unit whenever an engine file the front-end tests READ changes.

Root cause of the #2457 main break: #2457 changed src/surfaces/tools/registry.ts, FRONTEND_RE only matched frontend/, so fe-unit (test_1412/test_1414, which parse registry.ts) was skipped and ci-gate
passed. ci.yml now has FE_READS_ENGINE_RE; this test keeps it honest: every engine .ts path referenced from any front-end test must match it.
"""
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CI = (REPO / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")


def _filter() -> "re.Pattern[str]":
    m = re.search(r"FE_READS_ENGINE_RE='([^']+)'", CI)
    assert m, "FE_READS_ENGINE_RE is gone from ci.yml - engine-only PRs would skip fe-unit again (ORW-218)"
    return re.compile(m.group(1))


def _engine_files_read_by_fe_tests() -> set[str]:
    found: set[str] = set()
    for t in (REPO / "frontend" / "tests").glob("*.py"):
        if t.name == Path(__file__).name:
            continue
        txt = t.read_text(encoding="utf-8", errors="ignore")
        for m in re.finditer(r"""["']((?:src)/[A-Za-z0-9_./-]+\.ts)["']""", txt):
            found.add(m.group(1))
        for m in re.finditer(r"""["']src["']((?:\s*,\s*["'][A-Za-z0-9_.-]+["'])+)""", txt):
            parts = re.findall(r"""["']([A-Za-z0-9_.-]+)["']""", m.group(1))
            if parts and parts[-1].endswith(".ts"):
                found.add("src/" + "/".join(parts))
        for m in re.finditer(r"(?<![A-Za-z0-9_./-])(src/[A-Za-z0-9_/-]+\.ts)\b", txt):
            found.add(m.group(1))
    return {f for f in found if (REPO / f).is_file()}  # fixtures that merely MENTION a path (deploy tests) are not reads


def test_the_filter_covers_every_engine_file_the_frontend_tests_read():
    flt = _filter()
    files = _engine_files_read_by_fe_tests()
    assert files, "found no engine .ts reads in the front-end tests - the scan is broken"
    missing = sorted(f for f in files if not flt.search(f))
    assert not missing, (
        "front-end tests read these engine files but FE_READS_ENGINE_RE in .github/workflows/ci.yml does not match them, "
        "so an engine-only PR touching one would skip fe-unit (the #2457 failure). Add them to the regex: " + ", ".join(missing))
    assert flt.search("src/surfaces/tools/registry.ts") and flt.search("src/ports/GameSession.ts") and flt.search("src/adapters/mcp/McpServer.ts")

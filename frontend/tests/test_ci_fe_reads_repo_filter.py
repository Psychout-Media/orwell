"""ORW-416 - the CI path filter must run the front-end lanes whenever a repo file OUTSIDE frontend/ that a front-end test READS changes.

Root cause of the 2026-11-15 main break: #2681 changed only deploy/ (+ engine unit tests). The frontend filter matched only frontend/ (and, since ORW-218, the engine files in
FE_READS_ENGINE_RE), so fe-unit was skipped; frontend/tests/test_orw174_sqlite_wal.py reads deploy/orwell-backup.sh and pinned its old text, so the PR merged green and fe-unit then failed
on every PR until #2695. ci.yml now has FE_READS_REPO_RE. This test keeps it honest: every non-frontend, non-src path a front-end test reads (a literal path on a line that reads a file,
or a path built from a repo-root variable) must match the frontend filter. Its sibling test_ci_fe_reads_engine_filter.py covers the engine .ts files.
"""
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CI = (REPO / "ci" / "path-lanes.sh").read_text(encoding="utf-8")  # ORW-1044: the mapping lives in ci/path-lanes.sh

# Build output and scratch dirs are not repo files (dist/ exists only after `npm run build`, e.g. on the runners, never in the fe-unit CI job).
_TOPS = sorted(p.name for p in REPO.iterdir() if p.is_dir() and p.name not in ("frontend", "src", ".git", "node_modules", "dist", "coverage", "tmp", ".orwell-data"))
_ROOT_FILES = sorted(p.name for p in REPO.iterdir() if p.is_file() and not p.name.startswith("."))
_PART = r"[\"']([A-Za-z0-9_.-]+)[\"']"


def _filter() -> "re.Pattern[str]":
    parts = {}
    for name in ("FRONTEND_RE", "FE_READS_ENGINE_RE", "FE_READS_REPO_RE"):
        m = re.search(name + r"='([^']+)'", CI)
        assert m, f"{name} is gone from ci.yml - a change to a file the front-end tests read would skip fe-unit (ORW-416 / ORW-218)"
        parts[name] = m.group(1)
    assert re.search(r'frontend\)\s+re="\$FRONTEND_RE\|\$FE_READS_ENGINE_RE\|\$FE_READS_REPO_RE"', CI), \
        "the frontend lane no longer ORs FE_READS_REPO_RE into its filter (ORW-416)"
    return re.compile("|".join(f"(?:{p})" for p in parts.values()))


def _code_only(txt: str) -> str:
    """Drop docstrings / triple-quoted blocks and # comments, so a path merely MENTIONED in prose is not counted as a read."""
    txt = re.sub(r'(?s)("""|\'\'\').*?\1', "", txt)
    return "\n".join(re.sub(r"(^|\s)#.*$", "", line) for line in txt.splitlines())


def _paths_read_by_fe_tests() -> dict[str, set[str]]:
    """Every existing repo path (outside frontend/ and src/) a front-end test's CODE names: a literal "deploy/x.sh" string, or a run of quoted
    parts that starts at a top-level directory however it is joined - Path / "deploy" / "x", os.path.join(REPO, "deploy", "x"), _read("deploy", "x")."""
    found: dict[str, set[str]] = {}
    top_alt = "|".join(map(re.escape, _TOPS))
    for t in (REPO / "frontend" / "tests").glob("*.py"):
        if t.name in (Path(__file__).name, "test_ci_fe_reads_engine_filter.py"):
            continue
        code = _code_only(t.read_text(encoding="utf-8", errors="ignore"))
        for m in re.finditer(rf"[\"']((?:{top_alt})/[A-Za-z0-9_./-]*[A-Za-z0-9_-])", code):
            found.setdefault(m.group(1), set()).add(t.name)
        for m in re.finditer(rf"[\"']((?:{top_alt}))[\"']((?:\s*[,/]\s*{_PART})*)", code):
            parts = [m.group(1)] + re.findall(_PART, m.group(2))
            before = code[max(0, m.start() - 60):m.start()]
            if re.search(r"[\"']frontend[\"']\s*[,/]\s*$", before):
                continue  # REPO / "frontend" / "tests" / ... is a front-end path, not a repo top-level one
            rooted = re.search(r"(?:\b[A-Za-z_]*(?:ROOT|REPO)[A-Za-z_]*|parents\[2\])\s*\)?\s*[,/]\s*$", before)
            if len(parts) < 2 and not rooted:
                continue  # a lone "tests" / "debug" / "features" string is a key or a front-end-relative name, not a repo read
            if not rooted:  # an unrooted run of strings counts only if the WHOLE path exists at the repo root (a tuple of words or a front-end-relative helper does not)
                if (REPO / "/".join(parts)).exists():
                    found.setdefault("/".join(parts), set()).add(t.name)
                continue
            for k in range(len(parts), 0, -1):  # rooted at the repo: the longest prefix that exists (a directory read such as DEPLOY = ROOT / "deploy")
                if (REPO / "/".join(parts[:k])).exists():
                    found.setdefault("/".join(parts[:k]), set()).add(t.name)
                    break
        # review of #2709: two more shapes the scan above misses. A "../deploy/x.sh" path is relative to frontend/ (strip the ../), and a repo-ROOT file
        # (package.json, CLAUDE.md, ...) has no top-level directory to anchor on, so it is matched when its name sits next to a repo root.
        for m in re.finditer(rf"[\"'](?:\.\./)+((?:{top_alt})/[A-Za-z0-9_./-]*[A-Za-z0-9_-])", code):
            found.setdefault(m.group(1), set()).add(t.name)
        if _ROOT_FILES:
            root_alt = "|".join(map(re.escape, _ROOT_FILES))
            for m in re.finditer(rf"(?:\bREPO(?:_ROOT)?|\bROOT|parents\[2\])\s*\)?\s*[/,]\s*[\"']({root_alt})[\"']|[\"'](?:\.\./)+({root_alt})[\"']", code):
                found.setdefault(m.group(1) or m.group(2), set()).add(t.name)
    return {p: who for p, who in found.items() if (REPO / p).exists()}  # a fixture naming a path that does not exist is not a read


def test_the_filter_covers_every_repo_file_the_frontend_tests_read():
    flt = _filter()
    reads = _paths_read_by_fe_tests()
    assert any(p.startswith("deploy/") for p in reads), "found no deploy/ reads in the front-end tests - the scan is broken"
    # A directory read covers anything under it.
    missing = sorted(p for p in reads if not (flt.search(p) or ((REPO / p).is_dir() and flt.search(p.rstrip("/") + "/x"))))
    assert not missing, (
        "front-end tests read these repo paths but the frontend filter in .github/workflows/ci.yml (FRONTEND_RE | FE_READS_ENGINE_RE | FE_READS_REPO_RE) does not match them, "
        "so a PR touching only one of them would skip fe-unit (the #2681 failure). Add them to FE_READS_REPO_RE: "
        + "; ".join(f"{p} (read by {', '.join(sorted(reads[p]))})" for p in missing))


def test_the_2681_case_runs_the_frontend_lane():
    """The exact break: a deploy/-only change must select the frontend lane."""
    flt = _filter()
    assert flt.search("deploy/orwell-backup.sh") and flt.search("deploy/orwell-update.sh")

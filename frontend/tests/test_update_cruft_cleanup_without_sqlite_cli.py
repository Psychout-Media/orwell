"""orwell-update.sh's game-build cruft cleanup works on a box WITHOUT the sqlite3 CLI (production has none).

cleanup_inherited_cruft (issue #636) drops admin-added MCP-server rows for the browser / playwright / RAG /
Memory / Email servers from the front-end's app.db. It ran only `if command -v sqlite3`, and the production box
has python3 but no sqlite3 command-line tool, so the cleanup never ran there (the same gap as ORW-233). It now
writes through python3's built-in sqlite3 module, as the service user and never as root, and keeps the CLI path
only as a fallback for a box without python3.

The cleanup functions are taken from the REAL script and run with a PATH that has NO sqlite3 on it, against a
fixture DB; one end-to-end run of the whole updater proves the same with the sandboxed-box harness.
Name-agnostic: roles only.
"""
import getpass
import os
import shutil
import sqlite3
import subprocess
from pathlib import Path

import pytest

from test_update_script_failure_revert import Box, _combined, _write_exec, pytestmark  # noqa: F401  (harness + tool guard)

UPDATE = Path(__file__).resolve().parents[2] / "deploy" / "orwell-update.sh"
_TOOLS = ("bash", "python3", "timeout", "mktemp", "rm", "grep", "id", "cat", "sed", "tr", "head", "tail", "env",
          "dirname", "mv", "chmod", "awk", "sort")   # sqlite3 deliberately absent: production does not have it
needs_sqlite_cli = pytest.mark.skipif(shutil.which("sqlite3") is None, reason="sqlite3 CLI required")
not_root = pytest.mark.skipif(hasattr(os, "geteuid") and os.geteuid() == 0, reason="runs as an unprivileged user")

# (id, name, command, args, expected to be removed)
_ROWS = [
    ("builtin_browser", "Browser", "npx", '["@playwright/mcp"]', True),
    ("x1", "my-playwright-tools", "node", '["server.js"]', True),
    ("x2", "custom", "node", '["@playwright/mcp@latest"]', True),
    ("memory", "memory", "uvx", '["mcp-memory"]', True),
    ("rag", "RAG", "uvx", '["mcp-rag"]', True),
    ("keep1", "weather", "uvx", '["mcp-weather"]', False),
    ("keep2", "github", "npx", '["@modelcontextprotocol/server-github"]', False),
]


def _region(text, start_prefix, stop_prefix):
    lines = text.splitlines()
    begin = next(i for i, ln in enumerate(lines) if ln.startswith(start_prefix))
    stop = next(i for i in range(begin + 1, len(lines)) if lines[i].startswith(stop_prefix))
    return "\n".join(lines[begin:stop])


def _cleanup_lib(tmp_path):
    """Only the definitions the cleanup needs, taken verbatim from the real updater (no top-level side effects)."""
    text = UPDATE.read_text()
    lib = (_region(text, "# Run sqlite3 as the service USER, never as root", "# ── data/.env reconcile") + "\n"
           + _region(text, "game_build_on() {", "cleanup_inherited_cruft || true") + "\n")
    p = tmp_path / "cleanup-lib.sh"
    p.write_text(lib)
    return p


def _bin(tmp_path, *, without=("sqlite3",), extra=()):
    d = tmp_path / "bin"
    d.mkdir(exist_ok=True)
    for tool in _TOOLS + tuple(extra):
        real = shutil.which(tool)
        if tool not in without and real and not (d / tool).exists():
            (d / tool).symlink_to(real)
    return d


def _fake(bindir, name, body):
    p = bindir / name
    if p.exists() or p.is_symlink():
        p.unlink()
    p.write_text("#!/usr/bin/env bash\n" + body)
    p.chmod(0o755)


def _app(tmp_path, *, rows=_ROWS, table=True):
    app = tmp_path / "app"
    (app / "frontend" / "data").mkdir(parents=True)
    (app / "data").mkdir()
    (app / "data" / ".env").write_text("ORWELL_PORT=8080\n")
    db = app / "frontend" / "data" / "app.db"
    con = sqlite3.connect(db)
    if table:
        con.execute("CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, transport TEXT, command TEXT, "
                    "args TEXT, env TEXT, url TEXT, is_enabled BOOLEAN, oauth_config TEXT, disabled_tools TEXT, oauth_tokens TEXT)")
        con.executemany("INSERT INTO mcp_servers (id, name, transport, command, args) VALUES (?,?,?,?,?)",
                        [(i, n, "stdio", c, a) for i, n, c, a, _ in rows])
    else:
        con.execute("CREATE TABLE other (x)")
    con.commit()
    con.close()
    return app, db


def _ids(db):
    con = sqlite3.connect(db)
    try:
        return sorted(r[0] for r in con.execute("SELECT id FROM mcp_servers"))
    finally:
        con.close()


def _kept():
    return sorted(i for i, *_, gone in _ROWS if not gone)


def run_cleanup(tmp_path, bindir, app, env=None):
    lib = _cleanup_lib(tmp_path)
    full = {k: v for k, v in os.environ.items() if not k.startswith(("ORWELL_", "PYTHON"))}
    full.update(PATH=str(bindir), HOME=str(tmp_path / "home"))
    full.update(env or {})
    script = (f"set -euo pipefail; APP_DIR='{app}'; ENV_FILE='{app}/data/.env'; SVC_USER=\"${{SVC_USER:-{getpass.getuser()}}}\"; "
              f". '{lib}'; cleanup_inherited_cruft; echo CLEANUP-RC=$?")
    r = subprocess.run([str(bindir / "bash"), "-c", script], capture_output=True, text=True, timeout=60, env=full)
    assert r.returncode == 0 and "CLEANUP-RC=0" in r.stdout, r.stdout + r.stderr
    return r.stdout


@not_root
def test_inherited_rows_are_removed_with_no_sqlite3_cli_on_path(tmp_path):
    path = _bin(tmp_path)
    app, db = _app(tmp_path)
    out = run_cleanup(tmp_path, path, app)
    assert _ids(db) == _kept(), "the browser / playwright / RAG / Memory rows go, the operator's own servers stay"
    assert "removed 5 inherited MCP-server config row(s) from app.db" in out


@not_root
def test_no_mcp_table_is_a_quiet_no_op(tmp_path):
    path = _bin(tmp_path)
    app, db = _app(tmp_path, table=False)
    out = run_cleanup(tmp_path, path, app)
    assert "MCP-server" not in out


@not_root
def test_a_busy_db_is_left_alone_and_never_fails_the_update(tmp_path):
    path = _bin(tmp_path)
    app, db = _app(tmp_path)
    holder = sqlite3.connect(db, isolation_level=None)
    holder.execute("BEGIN EXCLUSIVE")                       # the front end mid-commit
    try:
        out = run_cleanup(tmp_path, path, app)
    finally:
        holder.execute("ROLLBACK")
        holder.close()
    assert len(_ids(db)) == len(_ROWS)
    assert "the next update retries" in out


@not_root
def test_the_full_workspace_build_keeps_every_row(tmp_path):
    path = _bin(tmp_path)
    app, db = _app(tmp_path)
    (app / "data" / ".env").write_text("ORWELL_PORT=8080\nORWELL_GAME_BUILD=0\n")
    run_cleanup(tmp_path, path, app)
    assert len(_ids(db)) == len(_ROWS)


@not_root
def test_as_root_the_write_runs_as_the_service_user(tmp_path):
    path = _bin(tmp_path)
    real_id = shutil.which("id")
    _fake(path, "id", f'if [[ "$*" == "-u" ]]; then echo 0; else exec {real_id} "$@"; fi\n')   # pretend to be root
    log = tmp_path / "runuser.log"
    _fake(path, "runuser", f'echo "$*" >> "{log}"\n[[ "$1" == -u && "$3" == -- ]] || exit 99\nshift 3\nexec "$@"\n')
    app, db = _app(tmp_path)
    me = getpass.getuser()
    run_cleanup(tmp_path, path, app, {"SVC_USER": me})
    assert _ids(db) == _kept()
    calls = log.read_text().splitlines()
    assert calls and calls[0].startswith(f"-u {me} -- python3 -I "), calls


@not_root
def test_as_root_without_a_usable_service_user_the_db_is_never_written(tmp_path):
    path = _bin(tmp_path)
    real_id = shutil.which("id")
    _fake(path, "id", f'if [[ "$*" == "-u" ]]; then echo 0; else exec {real_id} "$@"; fi\n')   # root, and no runuser on PATH
    app, db = _app(tmp_path)
    before = db.read_bytes()
    run_cleanup(tmp_path, path, app, {"SVC_USER": "no-such-user-xyz"})
    assert db.read_bytes() == before, "never write the front end's DB as root (root-owned sidecars break it)"


@needs_sqlite_cli
@not_root
def test_a_box_without_python3_falls_back_to_the_sqlite3_cli(tmp_path):
    path = _bin(tmp_path, without=("python3",), extra=("sqlite3",))
    app, db = _app(tmp_path)
    out = run_cleanup(tmp_path, path, app)
    assert _ids(db) == _kept()
    assert "removed 5 inherited MCP-server config row(s) from app.db" in out


# ── the whole updater, end to end: the python path runs; the CLI is never needed ─────────────────────────
_SQLITE_STUB = '#!/usr/bin/env bash\necho "sqlite3 $*" >> "$STUB_LOG"\necho "sqlite3: not installed on this box" >&2\nexit 127\n'


@not_root
def test_a_full_update_cleans_the_rows_without_ever_calling_the_sqlite3_cli(tmp_path):
    box = Box(tmp_path)
    box.v1 = box.commit("1")
    box.install()
    _write_exec(box.root / "bin" / "sqlite3", _SQLITE_STUB)   # a CLI that cannot run: the cleanup must not need it
    app = box.app
    (app / "frontend" / "data").mkdir(parents=True, exist_ok=True)
    db = app / "frontend" / "data" / "app.db"
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, transport TEXT, command TEXT, args TEXT)")
    con.executemany("INSERT INTO mcp_servers VALUES (?,?,?,?,?)", [(i, n, "stdio", c, a) for i, n, c, a, _ in _ROWS])
    con.commit()
    con.close()
    box.commit("2")
    r = box.run_update(ORWELL_SERVICE_USER=getpass.getuser())
    assert r.returncode == 0, _combined(r)
    assert _ids(db) == _kept()
    assert "removed 5 inherited MCP-server config row(s) from app.db" in r.stdout
    assert not [c for c in box.calls() if c.startswith("sqlite3 ")], "the sqlite3 CLI was never needed"

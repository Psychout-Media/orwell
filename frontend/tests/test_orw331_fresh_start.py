"""ORW-331 - the fresh-start wipe (front-end half) and the orchestrator script, over throwaway trees.

The wipe must clear games/sessions/chats and keep accounts, the encrypted endpoint rows, settings; print counts only; be idempotent. The shell script is
exercised end to end against stub box scripts (no systemd, no root, no network): refuses without a backup, takes and verifies one, wipes, updates to a pinned
sha only, post-checks, and rolls back. Roles only.
"""
import json
import os
import shutil
import sqlite3
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
FE = os.path.dirname(HERE)
REPO = os.path.dirname(FE)
SCRIPT = os.path.join(REPO, "deploy", "orwell-fresh-start.sh")
sys.path.insert(0, os.path.join(FE, "scripts"))
import fresh_start_wipe as w  # noqa: E402

SECRET = "sk-test-SECRET-VALUE-0000"


def _db(path, sessions=3, msgs=5):
    c = sqlite3.connect(path)
    c.executescript("""
      create table sessions(id text primary key, name text, headers text);
      create table chat_messages(id integer primary key, session_id text, content text);
      create virtual table chat_messages_fts using fts5(content, message_id, session_id, role);
      create trigger chat_messages_fts_ai after insert on chat_messages begin insert into chat_messages_fts(content,message_id,session_id,role) values (new.content,new.id,new.session_id,'x'); end;
      create trigger chat_messages_fts_ad after delete on chat_messages begin delete from chat_messages_fts where message_id=old.id; end;
      create table comparisons(id integer primary key);
      create table memories(id integer primary key, text text);
      create table model_endpoints(id text primary key, base_url text, api_key text);
      create table notes(id integer primary key, body text);
    """)
    for i in range(sessions):
        c.execute("insert into sessions values (?,?,?)", (f"s{i}", f"chat {i}", json.dumps({"Authorization": "Bearer " + SECRET})))
    for i in range(msgs):
        c.execute("insert into chat_messages(session_id,content) values (?,?)", (f"s{i % sessions}", f"line {i}"))
    c.execute("insert into comparisons values (1)")
    c.execute("insert into memories(text) values ('m')")
    c.execute("insert into model_endpoints values ('e1','https://api.deepseek.com','ENCRYPTED')")
    c.execute("insert into notes(body) values ('n')")
    c.commit()
    c.close()


def _data(tmp_path):
    d = tmp_path / "fe"
    d.mkdir()
    _db(str(d / "app.db"))
    for name in ("auth.json", ".app_key", "settings.json", "orwell_layout.json", "orwell_game_session.json", "orwell_sync_ledger.json", "orwell_belt_state.json"):
        (d / name).write_text("{}")
    return d


def _n(db, t):
    c = sqlite3.connect(db)
    try:
        return c.execute(f"select count(*) from {t}").fetchone()[0]
    finally:
        c.close()


def test_wipe_clears_games_and_chats_and_keeps_accounts_endpoints_settings(tmp_path):
    d = _data(tmp_path)
    res = w.wipe(str(d))
    db = str(d / "app.db")
    assert [_n(db, t) for t in ("sessions", "chat_messages", "comparisons", "memories", "chat_messages_fts")] == [0, 0, 0, 0, 0]
    assert _n(db, "model_endpoints") == 1 and _n(db, "notes") == 1
    for kept in ("auth.json", ".app_key", "settings.json", "orwell_layout.json"):
        assert (d / kept).exists(), kept
    for gone in ("orwell_game_session.json", "orwell_sync_ledger.json", "orwell_belt_state.json"):
        assert not (d / gone).exists(), gone
    assert res["rows"]["sessions"] == 3 and res["rows"]["chat_messages"] == 5


def test_dry_run_changes_nothing_and_a_second_run_is_a_clean_noop(tmp_path):
    d = _data(tmp_path)
    w.wipe(str(d), dry_run=True)
    assert _n(str(d / "app.db"), "sessions") == 3 and (d / "orwell_game_session.json").exists()
    w.wipe(str(d))
    again = w.wipe(str(d))
    assert again["rows"]["sessions"] == 0 and again["files"] == {}


def test_the_wipe_prints_counts_never_a_value(tmp_path, capsys):
    d = _data(tmp_path)
    assert w.main(["--data-dir", str(d)]) == 0
    out = capsys.readouterr().out
    assert SECRET not in out and "Bearer" not in out and "ENCRYPTED" not in out


def test_wipe_and_keep_sets_are_disjoint_and_cover_the_promise():
    assert not set(w.WIPE_TABLES) & set(w.KEEP_TABLES)
    assert not set(w.WIPE_FILES) & set(w.KEEP_FILES)
    assert "model_endpoints" in w.KEEP_TABLES and "auth.json" in w.KEEP_FILES and ".app_key" in w.KEEP_FILES and "settings.json" in w.KEEP_FILES


def test_a_missing_database_or_dir_is_handled(tmp_path):
    assert w.wipe(str(tmp_path))["rows"] == {}
    assert w.main(["--data-dir", str(tmp_path / "nope")]) == 2


# ── the orchestrator over a stub box ──────────────────────────────────────────────────────────────────────────

pytestmark_shell = pytest.mark.skipif(shutil.which("bash") is None or shutil.which("git") is None, reason="bash+git required")


def _box(tmp_path, healthy=True, update_ok=True):
    app = tmp_path / "app"
    (app / "deploy").mkdir(parents=True)
    (app / "data" / "ops").mkdir(parents=True)
    (app / "backups").mkdir()
    fe = app / "frontend" / "data"
    fe.mkdir(parents=True)
    _db(str(fe / "app.db"))
    (fe / "settings.json").write_text(json.dumps({"default_endpoint_id": "e1"}))
    (fe / "auth.json").write_text("{}")
    (app / "data" / ".env").write_text("X=1\n")
    for cmd in (["git", "init", "-q"], ["git", "-c", "user.email=a@b", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"]):
        subprocess.run(cmd, cwd=app, check=True, capture_output=True)
    sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=app, capture_output=True, text=True, check=True).stdout.strip()
    stubs = {
        "orwell-backup.sh": '#!/usr/bin/env bash\nset -e\nd="$1"; mkdir -p "$d"; t="$(mktemp -d)"; mkdir -p "$t/data" "$t/frontend/data"; cp -r "' + str(app) + '/frontend/data/." "$t/frontend/data/"; for i in 1 2 3 4 5 6; do echo x > "$t/data/f$i"; done\ntar czf "$d/orwell-backup-$(date +%s).tar.gz" -C "$t" data frontend\n',
        "orwell-game-reset.sh": '#!/usr/bin/env bash\necho "engine sandboxes cleared"\n',
        "orwell-update.sh": '#!/usr/bin/env bash\necho "update $* REF=${REF:-}" >> "' + str(tmp_path) + '/calls.log"\n' + ("exit 0\n" if update_ok else "exit 1\n"),
        "orwell-doctor.sh": '#!/usr/bin/env bash\necho "VERDICT: ' + ("healthy." if healthy else "still broken (1 failing check(s).") + '"\n',
        "orwell-ready.sh": '#!/usr/bin/env bash\n' + ("exit 0\n" if healthy else "echo '  x NOT READY - engine'; exit 1\n"),
        "orwell-restore.sh": '#!/usr/bin/env bash\necho "restored $1" >> "' + str(tmp_path) + '/calls.log"\n',
    }
    for n, body in stubs.items():
        p = app / "deploy" / n
        p.write_text(body)
        p.chmod(0o755)
    return app, sha


def _run(app, *args, extra=None):
    env = {**os.environ, "APP_DIR": str(app), "FRESH_TEST_NONROOT": "1", "FRESH_WIPE_PY": os.path.join(FE, "scripts", "fresh_start_wipe.py"), "FRESH_ALLOW_ONBOX": "1"}
    env.update(extra or {})
    return subprocess.run(["bash", SCRIPT, *args], env=env, capture_output=True, text=True, timeout=120)


@pytestmark_shell
def test_wipe_refuses_without_a_recorded_backup_and_changes_nothing(tmp_path):
    app, _ = _box(tmp_path)
    r = _run(app, "wipe", "--yes")
    assert r.returncode != 0 and "no recorded backup" in r.stderr
    assert _n(str(app / "frontend" / "data" / "app.db"), "sessions") == 3


@pytestmark_shell
def test_backup_wipe_update_postcheck_end_to_end_keeps_the_endpoint_and_leaves_zero_keyed_rows(tmp_path):
    app, sha = _box(tmp_path)
    r = _run(app, "all", "--ref", sha[:10], "--yes")
    out = r.stdout + r.stderr
    assert r.returncode == 0, out
    db = str(app / "frontend" / "data" / "app.db")
    assert _n(db, "sessions") == 0 and _n(db, "chat_messages") == 0
    assert _n(db, "model_endpoints") == 1
    assert (app / "frontend" / "data" / "auth.json").exists()
    assert "session rows holding an auth header: 0" in out
    assert "took" in out and SECRET not in out
    assert f"REF={sha[:10]}" in (tmp_path / "calls.log").read_text()
    assert list((app / "backups").glob("orwell-backup-*.tar.gz"))


@pytestmark_shell
def test_postcheck_fails_loudly_when_a_session_row_still_holds_a_key(tmp_path):
    app, _ = _box(tmp_path)
    r = _run(app, "postcheck")
    assert r.returncode != 0
    assert "session rows holding an auth header: 3" in r.stdout and SECRET not in r.stdout + r.stderr


@pytestmark_shell
def test_update_requires_a_pinned_sha_never_the_branch_tip(tmp_path):
    app, _ = _box(tmp_path)
    assert _run(app, "update").returncode != 0
    assert _run(app, "update", "--ref", "main").returncode != 0
    assert not (tmp_path / "calls.log").exists()


@pytestmark_shell
def test_a_failed_update_stops_the_run_and_names_the_rollback(tmp_path):
    app, sha = _box(tmp_path, update_ok=False)
    r = _run(app, "all", "--ref", sha[:10], "--yes")
    assert r.returncode != 0 and "rollback" in (r.stdout + r.stderr)


@pytestmark_shell
def test_rollback_restores_the_recorded_backup(tmp_path):
    app, sha = _box(tmp_path)
    assert _run(app, "backup").returncode == 0
    r = _run(app, "rollback")
    assert "restored" in (tmp_path / "calls.log").read_text(), r.stdout + r.stderr


@pytestmark_shell
def test_dry_run_wipe_changes_nothing(tmp_path):
    app, _ = _box(tmp_path)
    assert _run(app, "backup").returncode == 0
    r = _run(app, "wipe", "--dry-run")
    assert r.returncode == 0 and _n(str(app / "frontend" / "data" / "app.db"), "sessions") == 3


def test_script_never_pipes_into_grep_q_under_pipefail():
    # grep -q exits at the first match; the writer then dies of SIGPIPE and `set -o pipefail` reports the whole pipeline as failed (found by the dev rehearsal on a
    # real, larger archive; a tiny stub archive never trips it).
    src = open(SCRIPT, encoding="utf-8").read()
    assert "pipefail" in src
    bad = [ln for ln in src.splitlines() if "| grep -q" in ln and not ln.lstrip().startswith("#")]
    assert bad == [], bad

#!/usr/bin/env python3
"""ORW-331 - the front-end half of the "fresh start": clear the GAME and the CHATS, keep everything an operator never wants to re-enter.

WIPED (rows): the chat sessions, their messages (+ the full-text index through its own delete trigger), comparisons built from chats, and the
chat-derived memories. WIPED (files, under the front-end data dir): the canonical game-session binding, the sync ledger, the token ledger, the belt
state, the season/outcome history and the portrait log/reconcile files - all of it bound to the games being cleared.

KEPT: accounts (``auth.json``), the encrypted endpoint rows (``model_endpoints``) and the Fernet key that decrypts them (``.app_key``), the settings
file, the layout file, uploads/documents/gallery/notes/calendar/mail/integrations and every other table. The cast-portrait folder and the engine
saves are the shell script's job (``orwell-game-reset.sh``); this script never touches them.

Stdlib only (``sqlite3``), so it runs on a bare box before an update lands. Idempotent. ``--dry-run`` changes nothing. It prints COUNTS only, never a
row value. Services must be stopped by the caller (the shell script does that); the script refuses nothing itself but takes a short SQLite lock.

Usage: fresh_start_wipe.py --data-dir <frontend/data> [--dry-run] [--json]
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys

# Rows to clear, in an order that is FK-safe even with foreign keys on (children first).
WIPE_TABLES = ("chat_messages", "comparisons", "memories", "sessions")

# Files (relative to the data dir) that belong to the games being cleared.
WIPE_FILES = (
    "orwell_game_session.json", "orwell_sync_ledger.json", "orwell_token_ledger.json", "orwell_belt_state.json",
    "orwell_seasons.json", "orwell_outcomes.json", "portrait-log.jsonl", "portrait-reconcile.json",
)

# Never wiped. Listed so a test can pin that the two sets stay disjoint and a reader can see the promise.
KEEP_TABLES = ("model_endpoints", "api_tokens", "email_accounts", "mcp_servers", "integrations", "documents", "document_versions",
               "gallery_albums", "gallery_images", "notes", "calendars", "calendar_events", "signatures", "webhooks", "user_tools",
               "user_tool_data", "crew_members", "scheduled_tasks", "editor_drafts", "task_runs")
KEEP_FILES = ("auth.json", ".app_key", "settings.json", "orwell_layout.json", "api_keys.json", ".key")


def _count(conn: sqlite3.Connection, table: str) -> int | None:
    try:
        return int(conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])
    except sqlite3.Error:
        return None  # the table does not exist on this schema generation


def wipe(data_dir: str, dry_run: bool = False) -> dict:
    out: dict = {"dryRun": dry_run, "rows": {}, "files": {}, "kept": {}}
    db_path = os.path.join(data_dir, "app.db")
    if os.path.isfile(db_path):
        conn = sqlite3.connect(db_path, timeout=30)
        try:
            for t in KEEP_TABLES:
                n = _count(conn, t)
                if n is not None:
                    out["kept"][t] = n
            for t in WIPE_TABLES:
                n = _count(conn, t)
                if n is None:
                    continue
                out["rows"][t] = n
                if not dry_run and n:
                    conn.execute(f'DELETE FROM "{t}"')
            if not dry_run:
                conn.commit()
                try:
                    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                except sqlite3.Error:
                    pass
        finally:
            conn.close()
    for name in WIPE_FILES:
        p = os.path.join(data_dir, name)
        if os.path.isfile(p):
            out["files"][name] = "would remove" if dry_run else "removed"
            if not dry_run:
                os.remove(p)
    for name in KEEP_FILES:
        if os.path.isfile(os.path.join(data_dir, name)):
            out["kept"][name] = "present"
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    if not os.path.isdir(a.data_dir):
        print(f"ERROR: data dir {a.data_dir} not found", file=sys.stderr)
        return 2
    res = wipe(a.data_dir, a.dry_run)
    if a.json:
        print(json.dumps(res, sort_keys=True))
    else:
        verb = "would clear" if a.dry_run else "cleared"
        for t, n in res["rows"].items():
            print(f"  {verb} {n} row(s) from {t}")
        for f, s in res["files"].items():
            print(f"  {s}: {f}")
        for t, n in res["kept"].items():
            print(f"  kept {t}: {n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

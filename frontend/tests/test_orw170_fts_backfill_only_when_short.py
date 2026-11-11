"""ORW-170: the boot-time FTS backfill (O(messages x index) because message_id is UNINDEXED) only runs when the index has fewer rows than chat_messages. No model."""
import importlib
import sqlite3

import pytest


def _boot(monkeypatch, tmp_path, rows=0):
    db = importlib.import_module("core.database")
    path = tmp_path / "t.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE chat_messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, phase TEXT)")
    for i in range(rows):
        conn.execute("INSERT INTO chat_messages VALUES (?,?,?,?,?)", (f"m{i}", "s", "user", f"line {i}", None))
    conn.commit()
    conn.close()
    monkeypatch.setattr(db, "DATABASE_URL", f"sqlite:///{path}")
    return db, path


def _fts_count(path):
    c = sqlite3.connect(path)
    try:
        return c.execute("SELECT count(*) FROM chat_messages_fts").fetchone()[0]
    except sqlite3.OperationalError:
        pytest.skip("FTS5 unavailable in this sqlite build")
    finally:
        c.close()


def test_a_pre_existing_unindexed_history_is_still_backfilled(monkeypatch, tmp_path):
    db, path = _boot(monkeypatch, tmp_path, rows=5)
    db._migrate_chat_messages_fts()
    assert _fts_count(path) == 5


def test_a_second_boot_with_matching_counts_does_not_run_the_backfill(monkeypatch, tmp_path):
    db, path = _boot(monkeypatch, tmp_path, rows=5)
    db._migrate_chat_messages_fts()
    # count the statements the second boot runs: the backfill INSERT ... SELECT must not be among them
    seen = []
    real_connect = sqlite3.connect

    def spying_connect(*a, **k):
        conn = real_connect(*a, **k)
        conn.set_trace_callback(lambda stmt: seen.append(stmt))
        return conn

    monkeypatch.setattr(db.sqlite3, "connect", spying_connect)
    db._migrate_chat_messages_fts()
    assert not any("FROM chat_messages cm" in s for s in seen), "the O(n^2) backfill ran on a boot where the index was already complete"
    assert _fts_count(path) == 5


def test_a_short_index_is_repaired_on_the_next_boot(monkeypatch, tmp_path):
    db, path = _boot(monkeypatch, tmp_path, rows=3)
    db._migrate_chat_messages_fts()
    c = sqlite3.connect(path)
    c.execute("DELETE FROM chat_messages_fts WHERE message_id = 'm1'")
    c.commit()
    c.close()
    assert _fts_count(path) == 2
    db._migrate_chat_messages_fts()
    assert _fts_count(path) == 3

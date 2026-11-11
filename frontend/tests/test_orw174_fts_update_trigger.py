"""ORW-174: the chat_messages FTS update trigger only re-indexes a row when an INDEXED value changed (a phase/metadata update used to delete + re-insert, scanning the whole index). No model calls."""
import importlib
import sqlite3

import pytest


def _migrate(monkeypatch, tmp_path):
    db = importlib.import_module("core.database")
    path = tmp_path / "t.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE chat_messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, phase TEXT)")
    conn.commit()
    conn.close()
    monkeypatch.setattr(db, "DATABASE_URL", f"sqlite:///{path}")
    db._migrate_chat_messages_fts()
    conn = sqlite3.connect(path)
    try:
        conn.execute("SELECT 1 FROM chat_messages_fts LIMIT 1")
    except sqlite3.OperationalError:
        conn.close()
        pytest.skip("FTS5 unavailable in this sqlite build")
    return conn


def _fts_rowid(conn, mid):
    return conn.execute("SELECT rowid FROM chat_messages_fts WHERE message_id = ?", (mid,)).fetchone()[0]


def test_a_phase_only_update_does_not_touch_the_index(monkeypatch, tmp_path):
    c = _migrate(monkeypatch, tmp_path)
    c.execute("INSERT INTO chat_messages VALUES ('m1','s','assistant','hello orchard','casting')")
    c.execute("INSERT INTO chat_messages VALUES ('m2','s','user','another line','casting')")
    c.commit()
    before = _fts_rowid(c, "m1")
    c.execute("UPDATE chat_messages SET phase = 'game' WHERE id = 'm1'")
    c.commit()
    # with a second row present, the old delete + re-insert would have moved m1 to a NEW rowid (max + 1)
    assert _fts_rowid(c, "m1") == before


def test_a_content_update_still_reindexes(monkeypatch, tmp_path):
    c = _migrate(monkeypatch, tmp_path)
    c.execute("INSERT INTO chat_messages VALUES ('m1','s','assistant','hello orchard','casting')")
    c.commit()
    c.execute("UPDATE chat_messages SET content = 'goodbye harbor' WHERE id = 'm1'")
    c.commit()
    assert c.execute("SELECT count(*) FROM chat_messages_fts WHERE chat_messages_fts MATCH 'harbor'").fetchone()[0] == 1
    assert c.execute("SELECT count(*) FROM chat_messages_fts WHERE chat_messages_fts MATCH 'orchard'").fetchone()[0] == 0


def test_an_existing_database_with_the_old_trigger_is_upgraded(monkeypatch, tmp_path):
    c = _migrate(monkeypatch, tmp_path)
    c.execute("DROP TRIGGER chat_messages_fts_au")
    c.execute("CREATE TRIGGER chat_messages_fts_au AFTER UPDATE ON chat_messages BEGIN DELETE FROM chat_messages_fts WHERE message_id = old.id; END")
    c.commit()
    c.close()
    db = importlib.import_module("core.database")
    db._migrate_chat_messages_fts()  # a second boot over the same file
    c = sqlite3.connect(db.DATABASE_URL.replace("sqlite:///", ""))
    sql = c.execute("SELECT sql FROM sqlite_master WHERE name = 'chat_messages_fts_au'").fetchone()[0]
    assert "UPDATE OF" in sql and "WHEN" in sql

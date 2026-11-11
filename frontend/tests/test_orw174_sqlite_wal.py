"""ORW-174: the FE SQLite file runs in WAL mode with a busy_timeout and synchronous=NORMAL (file databases only); an in-memory database is left alone; the backup script checkpoints the WAL first. No model calls."""
import sqlite3
import subprocess
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text

from core import database  # noqa: F401  (registers the Engine "connect" listener)

REPO = Path(__file__).resolve().parents[2]


def _pragma(conn, name):
    return conn.execute(text(f"PRAGMA {name}")).scalar()


def test_a_file_database_opens_in_wal_with_a_busy_timeout(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path / 'x.db'}")
    with eng.connect() as c:
        assert str(_pragma(c, "journal_mode")).lower() == "wal"
        assert int(_pragma(c, "synchronous")) == 1  # NORMAL
        assert int(_pragma(c, "busy_timeout")) == 5000
        assert int(_pragma(c, "foreign_keys")) == 1  # the old pragma is untouched
    eng.dispose()


def test_an_in_memory_database_is_left_alone():
    eng = create_engine("sqlite://")
    with eng.connect() as c:
        assert str(_pragma(c, "journal_mode")).lower() == "memory"
        assert int(_pragma(c, "foreign_keys")) == 1
    eng.dispose()


def test_wal_survives_a_write_and_a_second_connection_reads_it(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path / 'y.db'}")
    with eng.begin() as c:
        c.execute(text("CREATE TABLE t (a INTEGER)"))
        c.execute(text("INSERT INTO t VALUES (1)"))
    other = sqlite3.connect(tmp_path / "y.db")
    assert other.execute("SELECT a FROM t").fetchone() == (1,)
    other.close()
    eng.dispose()


def test_the_backup_script_checkpoints_the_wal_before_tar():
    src = (REPO / "deploy" / "orwell-backup.sh").read_text()
    assert src.index("wal_checkpoint(TRUNCATE)") < src.index('tar -czf "$OUT"')
    assert subprocess.run(["bash", "-n", str(REPO / "deploy" / "orwell-backup.sh")]).returncode == 0

"""ORW-171 S1: get_session throttles the last_accessed touch to once per interval per session."""
import pytest
from sqlalchemy import event

from core import session_manager as smod
from core import database as db
from core.session_manager import SessionManager


@pytest.fixture
def sm():
    return SessionManager()


def _count_updates(fn):
    updates = []

    def listener(conn, cursor, statement, params, context, executemany):
        if statement.lstrip().upper().startswith("UPDATE SESSIONS"):
            updates.append(statement)

    event.listen(db.engine, "before_cursor_execute", listener)
    try:
        fn()
    finally:
        event.remove(db.engine, "before_cursor_execute", listener)
    return len(updates)


def test_fifty_reads_touch_once(sm):
    sid = "orw171-burst"
    sm.create_session(sid, "n", "http://x", "m", owner="u")

    def reads():
        for _ in range(50):
            sm.get_session(sid)

    assert _count_updates(reads) == 1


def test_touch_again_after_interval(sm, monkeypatch):
    sid = "orw171-interval"
    sm.create_session(sid, "n", "http://x", "m", owner="u")
    clock = [1000.0]
    monkeypatch.setattr(smod.time, "monotonic", lambda: clock[0])

    assert _count_updates(lambda: sm.get_session(sid)) == 1
    clock[0] += smod.TOUCH_INTERVAL_S - 0.5
    assert _count_updates(lambda: sm.get_session(sid)) == 0
    clock[0] += 1.0
    assert _count_updates(lambda: sm.get_session(sid)) == 1


def test_touch_map_bounded(monkeypatch):
    monkeypatch.setattr(smod, "_TOUCH_MAP_MAX", 10)
    smod._last_touch.clear()
    for i in range(50):
        smod._touch_due(f"s{i}")
    assert len(smod._last_touch) <= 10

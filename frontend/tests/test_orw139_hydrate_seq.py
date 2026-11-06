"""ORW-139 - rows hydrated from the DB after a restart must carry `_seq` (live-appended rows already do), so
/api/history keeps `seq` for every message. Live 11-06: history lost `seq` after the 04:14 restart."""
import importlib
from types import SimpleNamespace

sm = importlib.import_module("core.session_manager")


def _row(i, seq, meta=None):
    return SimpleNamespace(id=100 + i, seq=seq, role="user" if i % 2 == 0 else "assistant", content=f"m{i}",
                           meta_data=meta, timestamp=None)


def _dbs(rows):
    return SimpleNamespace(id="s1", name="n", endpoint_url="", model="m", rag=False, archived=False,
                           headers={}, messages=rows, owner=None, is_important=False, message_count=len(rows))


def test_relationship_hydration_sets_seq():
    mgr = object.__new__(sm.SessionManager)
    sess = mgr._db_to_session(_dbs([_row(0, 0), _row(1, 1, '{"k": 1}'), _row(2, 7)]), db=None)
    assert [m.metadata["_seq"] for m in sess.history] == [0, 1, 7]  # seq 0 is kept (not dropped as falsy)
    assert [m.metadata["_db_id"] for m in sess.history] == [100, 101, 102]
    assert sess.history[1].metadata["k"] == 1


def test_direct_query_hydration_sets_seq():
    rows = [_row(0, 3), _row(1, 4)]

    class _Q:
        def filter(self, *a, **k): return self
        def order_by(self, *a, **k): return self
        def all(self): return rows

    class _DB:
        def query(self, *a, **k): return _Q()

    mgr = object.__new__(sm.SessionManager)
    sess = mgr._db_to_session(_dbs([]), db=_DB())
    assert [m.metadata["_seq"] for m in sess.history] == [3, 4]

"""ORW-172 - optional, back-compatible paging on GET /api/history/{id} (?after_seq=&before_seq=&limit=).

Absent params must be EXACTLY today's response (full transcript, no extra key) - the F1-F5 gates and the reload paths still
see every message in order. With params: seq-cursored delta / older page / tail window, never reordering or rewriting a row.
No model. Roles only.
"""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from core.models import ChatMessage
from routes import history_routes
from routes.history_routes import page_history, setup_history_routes


def _rows(n):
    return [{"role": "user" if i % 2 else "assistant", "content": f"m{i}", "id": f"id{i}", "seq": i} for i in range(1, n + 1)]


# ── the pure pager ────────────────────────────────────────────────────────────────────────────────

def test_no_params_is_the_unpaged_response_untouched():
    rows = _rows(5)
    out, meta = page_history(rows, None, None, None)
    assert out is rows and meta is None


def test_after_seq_returns_the_delta_oldest_first_and_pages_forward_without_a_gap():
    rows = _rows(10)
    out, meta = page_history(rows, after_seq=6, limit=2)
    assert [r["seq"] for r in out] == [7, 8] and meta["hasMore"] is True and meta["lastSeq"] == 8
    out2, meta2 = page_history(rows, after_seq=meta["lastSeq"], limit=2)
    assert [r["seq"] for r in out2] == [9, 10] and meta2["hasMore"] is False


def test_bare_limit_is_the_newest_window_and_before_seq_pages_backwards():
    rows = _rows(10)
    out, meta = page_history(rows, limit=3)
    assert [r["seq"] for r in out] == [8, 9, 10] and meta["hasMore"] is True and meta["total"] == 10
    older, m2 = page_history(rows, before_seq=meta["firstSeq"], limit=3)
    assert [r["seq"] for r in older] == [5, 6, 7] and m2["hasMore"] is True
    oldest, m3 = page_history(rows, before_seq=5, limit=10)
    assert [r["seq"] for r in oldest] == [1, 2, 3, 4] and m3["hasMore"] is False


def test_pages_never_reorder_or_alter_rows():
    rows = _rows(6)
    out, _ = page_history(rows, after_seq=2, limit=3)
    assert out == rows[2:5]


def test_a_row_without_seq_is_left_out_of_a_cursor_query_but_kept_by_a_bare_limit():
    rows = _rows(3) + [{"role": "assistant", "content": "x"}]
    assert all("seq" in r for r in page_history(rows, after_seq=0)[0])
    assert page_history(rows, limit=2)[0][-1]["content"] == "x"


def test_limit_zero_and_negative_are_empty_not_everything():
    assert page_history(_rows(4), limit=0)[0] == []
    assert page_history(_rows(4), limit=-5)[0] == []


# ── the route ─────────────────────────────────────────────────────────────────────────────────────

class _Session:
    model = "m"
    endpoint_url = "u"
    name = "n"
    mode = "chat"

    def __init__(self, n):
        self.history = [ChatMessage(role="user" if i % 2 else "assistant", content=f"m{i}",
                                    metadata={"_db_id": f"id{i}", "_seq": i}) for i in range(1, n + 1)]


class _Mgr:
    def __init__(self, n):
        self.s = _Session(n)

    def get_session(self, sid):
        return self.s


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(history_routes, "_verify_session_owner", lambda *a, **k: None)
    import routes.chat_helpers as ch
    monkeypatch.setattr(ch, "player_visible_history", lambda session, rows: rows)
    app = FastAPI()
    app.include_router(setup_history_routes(_Mgr(10)))
    return TestClient(app)


def test_route_without_params_returns_everything_and_no_page_key(client):
    body = client.get("/api/history/s1").json()
    assert [r["seq"] for r in body["history"]] == list(range(1, 11))
    assert "page" not in body


def test_route_pages_by_cursor(client):
    body = client.get("/api/history/s1?after_seq=7").json()
    assert [r["seq"] for r in body["history"]] == [8, 9, 10] and body["page"]["hasMore"] is False
    body = client.get("/api/history/s1?limit=4").json()
    assert [r["seq"] for r in body["history"]] == [7, 8, 9, 10] and body["page"]["hasMore"] is True
    assert client.get("/api/history/s1?limit=abc").status_code == 422

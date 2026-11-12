"""ORW-275 slice 1 - numeric `week` row stamp + the week-chapter row/event on a turnIn that crosses a week boundary. Roles only."""
import json
import os

import pytest

from core.models import ChatMessage
from routes import chat_helpers as ch
from src import orwell_week_chapter as wc

FE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class _Sess:
    def __init__(self):
        self.history = []
        self.model = "m"

    def add_message(self, m):
        self.history.append(m)


class _Mgr:
    def __init__(self, sess):
        self.sess = sess
        self.saves = 0

    def get_session(self, sid):
        return self.sess

    def save_sessions(self):
        self.saves += 1


def _result(week=2, **recap):
    r = {"evicted": ["A"], "hoh": None, "standing": "You are still in the game. 15 houseguests remain."}
    r.update(recap)
    return {"output": json.dumps({"weekChapter": {"week": week, "recap": r}}), "exit_code": 0}


@pytest.fixture
def rig(monkeypatch):
    sess = _Sess()
    mgr = _Mgr(sess)
    published = []
    from src import orwell_game_session, session_events, ai_interaction
    monkeypatch.setattr(orwell_game_session, "get_game_session", lambda owner: "sid1")
    monkeypatch.setattr(ai_interaction, "get_session_manager", lambda: mgr)
    monkeypatch.setattr(session_events, "publish", lambda sid, ev, data=None: published.append((sid, ev, data)))
    ch._LAST_FRAMED_GAME_MOMENT["u275"] = "Week 2 · Nominations · Morning"
    yield sess, mgr, published
    ch._LAST_FRAMED_GAME_MOMENT.pop("u275", None)


# ── the numeric week stamp ──

def test_save_assistant_response_stamps_numeric_week_next_to_moment():
    sess, mgr = _Sess(), _Mgr(_Sess())
    ch.save_assistant_response(sess, mgr, "s", "text", None, game_moment="Week 3 · Veto", game_week=3, game=True)
    md = sess.history[-1].metadata
    assert md["week"] == 3 and isinstance(md["week"], int) and md["game_moment"] == "Week 3 · Veto"


def test_pre_game_rows_get_no_week():
    sess, mgr = _Sess(), _Mgr(_Sess())
    ch.save_assistant_response(sess, mgr, "s", "casting text", None, phase="casting")
    ch.save_assistant_response(sess, mgr, "s", "bad", None, game_week=0)
    ch.save_assistant_response(sess, mgr, "s", "bad", None, game_week=True)
    assert all("week" not in m.metadata for m in sess.history)


def test_stopped_partial_stamps_week():
    sess, mgr = _Sess(), _Mgr(_Sess())
    ch.save_stopped_partial(sess, mgr, "partial", None, game_week=4)
    assert sess.history[-1].metadata["week"] == 4


def test_current_game_week_default_keyed_and_framing_stashes_it():
    ch._LAST_FRAMED_GAME_WEEK["u_w"] = 5
    try:
        assert ch.current_game_week("u_w") == 5
        assert ch.current_game_week("other") is None
    finally:
        ch._LAST_FRAMED_GAME_WEEK.pop("u_w", None)
    src = open(os.path.join(FE, "routes/chat_helpers.py"), encoding="utf-8").read()
    assert '_LAST_FRAMED_GAME_WEEK[user or "default"] = _gw' in src


def test_all_four_chat_route_save_sites_pass_game_week():
    src = open(os.path.join(FE, "routes/chat_routes.py"), encoding="utf-8").read()
    assert src.count("game_week=(current_game_week(ctx.user) if ctx.game_active else None)") == 4


# ── the chapter row ──

def test_chapter_row_saved_with_metadata_and_published(rig):
    sess, mgr, published = rig
    assert wc.save_week_chapter("u275", _result(2)) is True
    m = sess.history[-1]
    assert m.role == "assistant"
    assert m.content == "Week 2. Out: A. You are still in the game. 15 houseguests remain."
    assert m.metadata["kind"] == "week-chapter" and m.metadata["week"] == 2 and m.metadata["phase"] == "game"
    assert m.metadata["recap"] == {"evicted": ["A"], "hoh": None, "standing": "You are still in the game. 15 houseguests remain."}
    assert m.metadata["game_moment"] == "Week 2 · Nominations · Morning"
    assert mgr.saves == 1
    assert published == [("sid1", "message-added", {"type": "week_chapter", "week": 2, "recap": m.metadata["recap"]})]


def test_replayed_turn_in_saves_no_second_row(rig):
    sess, mgr, published = rig
    assert wc.save_week_chapter("u275", _result(2)) is True
    assert wc.save_week_chapter("u275", _result(2)) is False
    assert len(sess.history) == 1 and len(published) == 1
    assert wc.save_week_chapter("u275", _result(3)) is True  # a later week is a new chapter
    assert len(sess.history) == 2


def test_no_chapter_in_result_or_error_saves_nothing(rig):
    sess, mgr, published = rig
    assert wc.save_week_chapter("u275", {"output": json.dumps({"dailyRecap": {"day": 1}}), "exit_code": 0}) is False
    assert wc.save_week_chapter("u275", {"error": "x", "exit_code": 1}) is False
    assert wc.save_week_chapter("u275", {"output": "not json"}) is False
    assert sess.history == [] and published == []


def test_hoh_line_in_fallback_text():
    got = wc.fallback_text({"week": 3, "recap": {"evicted": ["A", "B"], "hoh": "C", "standing": "S."}})
    assert got == "Week 3. Out: A, B. Head of Household: C. S."


def test_turn_in_dispatch_wires_the_chapter_save():
    src = open(os.path.join(FE, "src/tool_execution.py"), encoding="utf-8").read()
    assert "orwell_week_chapter.save_week_chapter(owner, result)" in src

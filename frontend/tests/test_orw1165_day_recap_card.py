"""ORW-1165 - the day's recap is its own chat message ("Day N in review"): a distinct row kind with a header and a card, saved between the night and the morning, once per day.

Stubbed session manager and engine; the card render is checked in Node and (on a runner with a browser) at 4K and phone widths. Roles only."""
import json
import os

import pytest

from src import orwell_day_recap as dr
from test_orw275_chapters import _node, _row, _game_chat, _select, _settled  # noqa: F401
from test_orw275_chapters import _stack  # noqa: F401
from _settle import app_ready

FE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

REC = {
    "day": 1,
    "highlights": ["You walked into the house", "The champagne toast: toasts from A and B"],
    "digest": [
        {"kind": "talk", "text": "You talked with A"},
        {"kind": "arrival", "text": "You walked into the house"},
        {"kind": "toast", "text": "The champagne toast: toasts from A and B"},
        {"kind": "deal", "text": "The Player and A make a safety deal"},
        {"kind": "bond", "text": "You grew closer to B"},
    ],
    "surfaced": ["A is wary of B"],
    "yourDay": [],
    "hook": {"thread": "surfaced:1", "framing": "what I heard today doesn't feel finished playing out"},
}


class _Sess:
    def __init__(self):
        self.history = []

    def add_message(self, m):
        self.history.append(m)


class _Mgr:
    def __init__(self, sess):
        self.sess, self.saves = sess, 0

    def get_session(self, sid):
        return self.sess

    def save_sessions(self):
        self.saves += 1


@pytest.fixture
def rig(monkeypatch):
    sess = _Sess()
    mgr = _Mgr(sess)
    published = []
    from src import orwell_game_session, session_events, ai_interaction
    monkeypatch.setattr(orwell_game_session, "get_game_session", lambda owner: "sid1")
    monkeypatch.setattr(ai_interaction, "get_session_manager", lambda: mgr)
    monkeypatch.setattr(session_events, "publish", lambda sid, ev, data=None: published.append((sid, ev, data)))
    return sess, mgr, published


def _turn_in(rec):
    return {"output": json.dumps({"status": {}, "dailyRecap": rec}), "exit_code": 0}


def test_the_recap_is_its_own_row_with_the_header_and_grouped_kinds(rig):
    sess, mgr, published = rig
    assert dr.save_from_turn_in("u1165", _turn_in(REC)) is True
    m = sess.history[-1]
    assert m.role == "assistant" and m.metadata["kind"] == "day-recap" and m.metadata["day"] == 1
    assert m.content.startswith("Day 1 in review.")
    assert "You walked into the house" in m.content and "Tomorrow:" in m.content and "Word that reached you" in m.content
    kinds = [d["kind"] for d in m.metadata["recap"]["digest"]]
    assert kinds == ["arrival", "toast", "deal", "bond", "talk"]  # grouped in the card's order, not the order of the record
    assert published == [("sid1", "message-added", {"type": "day_recap", "day": 1})]
    assert mgr.saves == 1


def test_a_replayed_turn_in_saves_no_second_card_and_a_later_day_is_a_new_card(rig):
    sess, mgr, published = rig
    assert dr.save_from_turn_in("u1165", _turn_in(REC)) is True
    assert dr.save_from_turn_in("u1165", _turn_in(REC)) is False
    assert dr.save_day_recap("u1165", REC) is False
    assert len(sess.history) == 1 and len(published) == 1
    assert dr.save_day_recap("u1165", dict(REC, day=2)) is True
    assert len(sess.history) == 2


def test_an_empty_recap_or_an_error_result_saves_nothing(rig):
    sess, _, published = rig
    assert dr.save_from_turn_in("u1165", _turn_in({"day": 1, "highlights": [], "surfaced": []})) is False
    assert dr.save_from_turn_in("u1165", {"error": "x", "exit_code": 1}) is False
    assert dr.save_from_turn_in("u1165", {"output": "{}", "exit_code": 0}) is False
    assert sess.history == [] and published == []


def test_an_older_engine_without_a_digest_still_gets_a_card_from_its_highlights(rig):
    sess, _, _ = rig
    assert dr.save_day_recap("u1165", {"day": 1, "highlights": ["a deal was struck"], "yourDay": ["a quiet hour"], "surfaced": []}) is True
    assert [d["text"] for d in sess.history[-1].metadata["recap"]["digest"]] == ["a deal was struck", "a quiet hour"]


def test_a_normal_turn_in_without_a_recap_adds_no_row(rig):
    sess, _, _ = rig
    assert dr.save_from_turn_in("u1165", {"output": json.dumps({"status": {}}), "exit_code": 0}) is False
    assert sess.history == []


def test_reissue_is_a_dry_run_by_default_and_once_only(rig, monkeypatch):
    sess, mgr, published = rig
    from src import orwell_engine
    calls = []

    async def fake_call(name, args=None, user=None, **kw):
        calls.append((name, args))
        return REC

    monkeypatch.setattr(orwell_engine, "_call", fake_call)
    import asyncio
    r = asyncio.run(dr.reissue("u1165", 1))
    assert r["status"].startswith("dry-run") and sess.history == [] and calls == [("dailyRecap", {"rebuildDay": 1})]
    r = asyncio.run(dr.reissue("u1165", 1, apply=True))
    assert r["status"] == "issued" and len(sess.history) == 1
    r = asyncio.run(dr.reissue("u1165", 1, apply=True))
    assert r["status"] == "already-issued" and len(sess.history) == 1
    r = asyncio.run(dr.reissue("u1165", 2, apply=True))  # the engine answered another day: nothing issued
    assert r["status"].startswith("no-recap") and len(sess.history) == 1


def test_the_turn_in_dispatcher_saves_the_card_and_the_narrator_is_told_not_to_voice_it():
    src = open(os.path.join(FE, "src/tool_execution.py"), encoding="utf-8").read()
    assert "orwell_day_recap.save_from_turn_in(owner, result)" in src
    from src import agent_loop as al
    note = al._bedtime_recap_directive(json.dumps({"dailyRecap": REC}))
    assert "already shown" in note and "do NOT voice" in note
    assert al._bedtime_recap_directive(json.dumps({"dailyRecap": {"day": 1, "highlights": [], "surfaced": []}})) == ""


def test_the_card_html_has_the_header_is_escaped_and_leaves_out_empty_parts():
    out = _node("""process.stdout.write(JSON.stringify([
      c.dayRecapCardHtml({day: 3, recap: {digest: [{kind: 'arrival', text: 'A <b>'}, {kind: 'deal', text: 'a deal'}], surfaced: ['heard <i>'], hook: 'it is not over'}}, (x) => String(x).replace(/</g,'&lt;')),
      c.dayRecapCardHtml({day: 4, recap: {digest: [{kind: 'talk', text: 'You talked with B'}], surfaced: [], hook: null}}, (x) => String(x))]));""")
    assert "Day 3 in review" in out[0] and "A &lt;b>" in out[0] and "heard &lt;i>" in out[0] and "Tomorrow:" in out[0] and "Arrivals" in out[0]
    assert "Day 4 in review" in out[1] and "Tomorrow" not in out[1] and "Word that reached you" not in out[1]


@pytest.mark.browser
@pytest.mark.parametrize("size", [(3840, 2160), (390, 844)])
def test_the_card_renders_as_its_own_message_on_a_tv_and_a_phone(_stack, size):  # noqa: F811
    from playwright.sync_api import sync_playwright
    sid = _game_chat(_stack, f"ch1165-{size[0]}")
    h = [_row("user", "I go to bed", week=1),
         _row("assistant", "Day 1 in review.", kind="day-recap", day=1, recap={"digest": REC["digest"], "surfaced": REC["surfaced"], "hook": "what I heard today does not feel finished"}),
         _row("assistant", "The morning comes.", week=1)]
    hist = [dict(m, id=f"id{i}", seq=i + 1) for i, m in enumerate(h)]
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:  # noqa: BLE001
            pytest.skip(f"chromium unavailable: {e}")
        ctx = browser.new_context(viewport={"width": size[0], "height": size[1]})
        page = ctx.new_page()
        page.route("**/api/history/**", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps({"history": hist, "model": "stub-narrator"})))
        page.goto(_stack["fe"] + "/#" + sid, wait_until="load")
        app_ready(page, names=("chatModule", "sessionModule"))
        _select(page, sid)
        page.wait_for_selector(".ow-day-recap", timeout=15000)
        _settled(page)
        card = page.inner_text(".ow-day-recap")
        assert "Day 1 in review" in card and "You grew closer to B" in card and "Tomorrow" in card, card
        assert page.evaluate("() => document.querySelector('.msg[data-kind=day-recap]') !== null")
        assert page.evaluate("() => { const m = document.querySelector('.msg[data-kind=day-recap]'); return !m.querySelector('.msg-footer') || getComputedStyle(m.querySelector('.msg-footer')).display === 'none'; }")
        assert page.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth + 1")  # no sideways scroll on a phone
        fs = page.evaluate("() => parseFloat(getComputedStyle(document.querySelector('.ow-day-recap')).fontSize)")
        assert fs >= (24 if size[0] >= 2400 else 14), fs
        browser.close()

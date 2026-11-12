"""ORW-275 (Lane B half): week chapters. The pure chapter logic (Node) + the chapter bar and re-render in a real browser against the live stack, with /api/history faked so
the transcript spans two game weeks. Roles only; no model."""
import json
import os
import shutil
import subprocess

import pytest

STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "js")


def _node(program):
    node = shutil.which("node")
    if not node:
        pytest.skip("node not available")
    mod = os.path.join(STATIC, "orwellChapters.js").replace("\\", "/")
    p = subprocess.run([node, "--input-type=module", "-e", f"import * as c from 'file://{mod}';\n{program}"], capture_output=True, text=True, timeout=30)
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)


def _row(role, text, **md):
    return {"role": role, "content": text, "metadata": md}


HIST = [
    _row("assistant", "casting talk"),                                   # no week: inherits the first chapter
    _row("assistant", "w1 a", game_moment="Week 1 · Premiere · Evening"),
    _row("user", "w1 b", game_moment="Week 1 · Nominations · Morning"),
    _row("assistant", "w2 a", week=2),
    _row("user", "w2 b", game_moment="Week 2 · Veto competition · Evening"),
    _row("assistant", "w2 stray", game_moment="Week 1 · stale stamp"),   # a stray older stamp can never reopen an older chapter
]


def test_chapter_of_message_prefers_the_numeric_week_then_the_game_moment():
    out = _node(f"const r={json.dumps(HIST)};process.stdout.write(JSON.stringify(r.map(c.chapterOfMessage)));")
    assert out == [None, 1, 1, 2, 2, 1]


def test_index_fills_gaps_forward_and_never_goes_backwards():
    out = _node(f"const i=c.chapterIndex({json.dumps(HIST)});process.stdout.write(JSON.stringify(i));")
    assert out["weeks"] == [1, 2] and out["current"] == 2
    assert out["rowWeek"] == [1, 1, 1, 2, 2, 2]


def test_slice_for_view_current_and_past_and_inactive():
    out = _node(f"""const h={json.dumps(HIST)};
const t=(v)=>c.sliceForView(h,v).map(m=>m.content);
process.stdout.write(JSON.stringify({{cur:t('current'),w1:t(1),bad:t(9),one:c.sliceForView(h.slice(0,3),'current').length,same:c.sliceForView(h.slice(0,3),'current')===undefined}}));""")
    assert out["cur"] == ["w2 a", "w2 b", "w2 stray"]
    assert out["w1"] == ["casting talk", "w1 a", "w1 b"]
    assert out["bad"] == out["cur"]            # an unknown week falls back to the current one
    assert out["one"] == 3                    # fewer than two weeks: untouched


def test_rows_for_returns_the_same_array_when_chapters_are_not_active():
    out = _node("const h=[{role:'user',content:'x',metadata:{game_moment:'Week 1 · A'}}];process.stdout.write(JSON.stringify(c.rowsFor('s',h)===h));")
    assert out is True


def test_rows_for_filters_to_the_view_of_that_session():
    out = _node(f"""const h={json.dumps(HIST)};
const a=c.rowsFor('s1',h).map(m=>m.content);
c.setView('s1',1);
const b=c.rowsFor('s1',h).map(m=>m.content);
const o=c.rowsFor('s2',h).map(m=>m.content);
c.setView('s1','current');
process.stdout.write(JSON.stringify({{a,b,o,view:c.getView('s1')}}));""")
    assert out["a"] == ["w2 a", "w2 b", "w2 stray"] and out["b"] == ["casting talk", "w1 a", "w1 b"]
    assert out["o"] == out["a"] and out["view"] == "current"


def test_the_goodnight_row_saved_after_the_chapter_row_stays_in_the_week_it_closes():
    # storage order on an eviction night: ...week 1 rows, the week-chapter row (week 2), the narrator's goodnight (stamped week 1), then week 2 rows
    h = [_row("assistant", "w1 a", week=1),
         _row("assistant", "Week 2. Out: X.", kind="week-chapter", week=2, recap={"evicted": ["X"], "hoh": None, "standing": "You are still in the game. 5 houseguests remain."}),
         _row("assistant", "goodnight", week=1),
         _row("user", "w2 a", week=2),
         _row("assistant", "w2 unstamped")]
    out = _node(f"const h={json.dumps(h)};const i=c.chapterIndex(h);process.stdout.write(JSON.stringify({{rw:i.rowWeek,w1:c.sliceForView(h,1).map(m=>m.content),cur:c.sliceForView(h,'current').map(m=>m.content)}}));")
    assert out["rw"] == [1, 2, 1, 2, 2]
    assert out["w1"] == ["w1 a", "goodnight"]
    assert out["cur"] == ["Week 2. Out: X.", "w2 a", "w2 unstamped"]


def test_the_recap_card_is_escaped_and_leaves_out_empty_parts():
    out = _node("""process.stdout.write(JSON.stringify([
      c.weekChapterCardHtml({week: 3, recap: {evicted: ['A <b>', 'B'], hoh: null, standing: 'You are on the block.'}}, (x) => String(x).replace(/</g,'&lt;')),
      c.weekChapterCardHtml({week: 4, recap: {evicted: [], hoh: null, standing: ''}}, (x) => String(x))]));""")
    assert "Week 3" in out[0] and "A &lt;b>, B" in out[0] and "You are on the block." in out[0] and "Head of Household" not in out[0]
    assert "Out:" not in out[1] and "Week 4" in out[1]


# ── a real browser against the live stack, /api/history faked to span two weeks ──────────────────────

from test_m0_3_midgen_join import STUB, _stack  # noqa: E402,F401
from test_p0h_day1_clock_e2e import _session  # noqa: E402

pytestmark_browser = pytest.mark.browser


@pytest.mark.browser
def test_the_bar_shows_the_current_week_and_a_past_week_is_one_tap_away(_stack):  # noqa: F811
    from playwright.sync_api import sync_playwright
    sid = _session(_stack, "ch275")
    hist = [dict(m, id=f"id{i}", seq=i + 1) for i, m in enumerate(HIST)]
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:  # noqa: BLE001
            pytest.skip(f"chromium unavailable: {e}")
        page = browser.new_context().new_page()
        page.route("**/api/history/**", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps({"history": hist, "model": "stub-narrator"})))
        page.goto(_stack["fe"] + "/", wait_until="load")
        page.wait_for_timeout(2500)
        page.evaluate("(id) => window.sessionModule ? window.sessionModule.selectSession(id) : null", sid)
        page.wait_for_selector("#orwell-chapter-bar", timeout=15000)
        txt = lambda: page.evaluate("() => Array.from(document.querySelectorAll('#chat-history .msg')).map(e => e.textContent.replace(/\\s+/g,' ').trim())")  # noqa: E731
        page.wait_for_function("() => document.querySelectorAll('#chat-history .msg').length >= 3", timeout=15000)
        cur = txt()
        assert any("w2 a" in t for t in cur) and not any("w1 a" in t for t in cur), cur
        assert "Week 2" in page.inner_text("#orwell-chapter-bar")
        page.select_option("#orwell-chapter-bar select", "1")
        page.wait_for_function("() => document.querySelector('#chat-history').textContent.includes('w1 a')", timeout=15000)
        past = txt()
        assert any("w1 a" in t for t in past) and not any("w2 a" in t for t in past), past
        assert "Reading Week 1" in page.inner_text("#orwell-chapter-bar")
        page.click("#orwell-chapter-bar button[data-action=current]")
        page.wait_for_function("() => document.querySelector('#chat-history').textContent.includes('w2 a')", timeout=15000)
        browser.close()


@pytest.mark.browser
def test_the_boundary_row_renders_as_a_recap_card_with_no_footer_actions(_stack):  # noqa: F811
    from playwright.sync_api import sync_playwright
    sid = _session(_stack, "ch275b")
    h = [_row("assistant", "w1 a", week=1),
         _row("assistant", "Week 2. Out: X.", kind="week-chapter", week=2, recap={"evicted": ["Xavier"], "hoh": None, "standing": "You are still in the game. 5 houseguests remain."}),
         _row("assistant", "goodnight", week=1),
         _row("user", "w2 hello", week=2)]
    hist = [dict(m, id=f"id{i}", seq=i + 1) for i, m in enumerate(h)]
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:  # noqa: BLE001
            pytest.skip(f"chromium unavailable: {e}")
        page = browser.new_context().new_page()
        page.route("**/api/history/**", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps({"history": hist, "model": "stub-narrator"})))
        page.goto(_stack["fe"] + "/", wait_until="load")
        page.wait_for_timeout(2500)
        page.evaluate("(id) => window.sessionModule ? window.sessionModule.selectSession(id) : null", sid)
        page.wait_for_selector("#orwell-chapter-bar", timeout=15000)
        page.wait_for_selector(".ow-week-card", timeout=15000)
        card = page.inner_text(".ow-week-card")
        assert "Week 2" in card and "Xavier" in card and "5 houseguests remain" in card, card
        assert page.evaluate("() => { const m = document.querySelector('.msg[data-kind=week-chapter]'); return !!m && (!m.querySelector('.msg-footer') || getComputedStyle(m.querySelector('.msg-footer')).display === 'none'); }")
        body = page.inner_text("#chat-history")
        assert "w2 hello" in body and "goodnight" not in body and "w1 a" not in body  # the closing week's goodnight is in the past chapter
        browser.close()

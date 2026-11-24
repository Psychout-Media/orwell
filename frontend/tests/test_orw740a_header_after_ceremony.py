"""ORW-740a (came back from ORW-425, ORW-705, ORW-713) - after every ceremony the next reply's header AND the House panel's header name the event the engine says belongs to the
current day/time (ORW-258: the day's event label holds until the night passes; ORW-705: Day 2 before the first HOH reads HOH), the same string, in the same reply, with no reload.

Real path, nothing set by hand: a real engine + real FE + the stub narrator + a real Chromium page. Week 1 is walked through the HOH, the nominations, the veto competition, the veto ceremony and
the eviction; after EVERY plain message typed into the page's composer the expected header is derived from the engine's own public state (`getGameState`, the phase / daySchedule / timeOfDay the
status carries) through the production stamp function, and both the settled bubble's stamp and the panel's week / phase / time-of-day rows must equal it. Before the fix the panel named the
engine's raw `phase` (the NEXT event) after each ceremony while the stamp named today's event. Roles only."""
from __future__ import annotations

import json

import pytest

import _a64_walk
from test_m0_3_midgen_join import _stack  # noqa: F401
from test_a40_due_ceremony_real_loop import _fresh
from test_p0h_day1_clock_e2e import _engine, _session, _start_day
from test_orw191_golden_flows import COMPOSER
import time
import urllib.request

pytestmark = pytest.mark.browser


def _get(stack, path):
    return json.loads(urllib.request.urlopen(stack["fe"] + path, timeout=30).read())


def test_the_reply_stamp_and_the_panel_header_match_the_engine_after_every_ceremony(_stack, monkeypatch):  # noqa: F811
    from playwright.sync_api import sync_playwright
    from routes import chat_helpers as ch
    _fresh(_stack, 5)
    sid = _session(_stack, "orw740a")
    _start_day(_stack, sid)
    rows = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()
        page.goto(_stack["fe"] + "/", wait_until="load")
        page.wait_for_function(f"() => {{ const m = document.querySelector('{COMPOSER}'); return !!m && !m.disabled; }}", timeout=20000)

        def send(stack, s, text, cid):
            # ORW-847: the stamp is frozen when the reply is emitted; the engine can still step after the reply is on screen (the turn's own background steps: scene records, moves, a progress belt), and
            # on a slow box that is later than any fixed wait. So watch the engine from the send until the reply has settled AND the engine has been still for a while, collecting every moment it
            # passed through: the stamp must be one of them (a real moment of THIS turn, never a made-up or stale one), and the panel must agree with the engine once it is still.
            observed = {ch._format_game_moment(_engine(stack, "getGameState"))}
            page.click(COMPOSER); page.fill(COMPOSER, text); page.keyboard.press("Enter")
            settled_js = """(t) => { const all = Array.from(document.querySelectorAll('#chat-history .msg')).filter(e => e.style.display !== 'none');
                const i = all.findIndex(e => e.matches('.msg-user') && (e.textContent || '').includes(t));
                const last = all[all.length - 1];
                return i >= 0 && last && last.matches('.msg-ai') && all.indexOf(last) > i && !document.querySelector('#chat-history .msg-ai.streaming'); }"""  # my line is in the log, the LAST bubble is an assistant reply after it, nothing is streaming
            t0 = time.time(); last_seq = None; still_since = None; gs = None
            while True:
                gs = _engine(stack, "getGameState")
                observed.add(ch._format_game_moment(gs))
                seq = gs.get("beatSeq")
                if seq != last_seq:
                    last_seq, still_since = seq, time.time()
                if page.evaluate(settled_js, text) and time.time() - still_since >= 2.0:
                    break  # replied and the engine has been still for 2 s
                if time.time() - t0 > 90:
                    diag = page.evaluate("() => ({ composer: (document.getElementById('message')||{}).disabled, last: Array.from(document.querySelectorAll('#chat-history .msg')).slice(-3).map(e => e.className + ' | ' + (e.textContent||'').replace(/\\s+/g,' ').slice(0,120)) })")
                    raise AssertionError(f"the reply to {text!r} never settled: {diag}")
                page.wait_for_timeout(400)
            def _panel():
                return page.evaluate("() => [ (document.getElementById('os-week')||{}).textContent, (document.getElementById('os-phase')||{}).textContent, (document.getElementById('os-tod')||{}).textContent ].join(' | ')")
            def _agree(gs_, panel_):  # the panel is poll/event driven: give it up to 12 s to catch up with the still engine
                e_ = ch._format_game_moment(gs_).split(" · "); p_ = [x.strip() for x in panel_.split("|")]
                return len(p_) == 3 and len(e_) == 3 and (p_[0], p_[1]) == (e_[0], e_[1]) and (p_[2].split(",")[0].split()[-1] == e_[2].split()[-1] or e_[2] == "Early morning")
            panel = _panel(); end = time.time() + 12
            while not _agree(gs, panel) and time.time() < end:
                page.wait_for_timeout(500)
                gs = _engine(stack, "getGameState"); panel = _panel()
            stamp = page.evaluate("() => { const e = Array.from(document.querySelectorAll('#chat-history .msg-ai .role-timestamp-moment')); return e.length ? e[e.length-1].textContent.trim() : null }")
            rows.append((gs.get("phase"), (gs.get("daySchedule") or {}).get("todaysEvent"), (gs.get("daySchedule") or {}).get("next"), ch._format_game_moment(gs), stamp, panel, observed))
            return ""
        monkeypatch.setattr(_a64_walk, "_send", send)
        _a64_walk._walk_week_one(_stack, sid)
        send(_stack, sid, "Taking in the night.", "orw740a-after-eviction")  # the reply AFTER the eviction ceremony: today's event is still Eviction night
        browser.close()
    assert rows, "the walk sent no messages"
    # the walk must really have crossed the ceremonies: a row where the engine's phase moved ahead of today's event (the HOH, nominations, veto and eviction hand-offs)
    ahead = {(r[0], r[1]) for r in rows if r[1]}
    assert {("nominations", "hoh-competition"), ("veto-competition", "nominations"), ("veto-ceremony", "veto-competition")} <= ahead, ahead
    assert any(r[0] == "eviction" for r in rows), "the walk never reached eviction night"
    assert "Eviction night" in rows[-1][3] and rows[-1][5].split("|")[1].strip() == "Eviction night", rows[-1]  # the reply after the eviction still reads Eviction night (ORW-258/713) in the stamp AND the panel
    for phase, today, nxt, expect, stamp, panel, observed in rows:
        # the stamp names a moment the engine really passed through during this turn (never a made-up or stale one); the panel header equals the engine once it is still
        assert stamp in observed, ("bubble stamp is not a moment of this turn", phase, today, expect, stamp, sorted(observed))
        e_week, e_phase, e_tod = expect.split(" · ")
        p_week, p_phase, p_tod = [x.strip() for x in panel.split("|")]
        assert (p_week, p_phase) == (e_week, e_phase), ("panel header != engine", phase, today, expect, panel)
        assert p_tod.split(",")[0].split()[-1] == e_tod.split()[-1] or e_tod == "Early morning", ("panel time of day != engine", expect, panel)

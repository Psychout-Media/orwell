"""ORW-771, real browser: a Continue press through the eviction vote sends the hidden vote-beat cue to the narrator, and only then.

The real orwellDecision.js in Chromium, API calls stubbed (the engine half and the real chat turn are test_orw771_vote_beat_real_stack.py). The press response carries the engine's sealed
`eviction.voteBeat`: the page must send exactly ONE hidden cue through the chat module's sendHiddenCue (no player bubble, never a typed message); a press with no beat fact sends nothing
(the flag-off, banner-only press, byte for byte); a press while a beat is already streaming piles no second cue behind it; and the chyron `announcements` still ride the press (ORW-703).
Own module so conftest routes it to the serial browser lane. Roles only."""
import json
import os
import sys

import pytest

from _settle import frames

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))


@pytest.fixture(scope="module")
def fe():
    import responsive_matrix as rm
    proc = rm.boot_fe()
    yield rm.FE
    rm.stop_fe(proc)


def _j(o, status=200):
    return {"status": status, "content_type": "application/json", "body": json.dumps(o)}


BALLOT = {"kind": "ceremony-step", "id": "eviction-3", "binding": False, "text": "A vote to evict a nominee has been read.",
          "ceremony": {"kind": "eviction", "step": 3, "of": 16, "stepId": "ballot"}}
BEAT = {"sealed": True, "press": 1, "of": 14, "intoDiaryRoom": {"id": "npc:1", "name": "Role One"}, "tallyRead": False, "gathered": 14, "nominees": []}


def _run(fe, press_response, active_stream=False):
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True).new_page()
            page.route("**/api/orwell/state", lambda r: r.fulfill(**_j({"started": True, "asleep": []})))
            page.route("**/api/orwell/status", lambda r: r.fulfill(**_j({"pending": BALLOT})))
            page.route("**/api/orwell/roster", lambda r: r.fulfill(**_j({"roster": []})))
            page.route("**/api/orwell/whereabouts", lambda r: r.fulfill(**_j({"whereabouts": {"room": "kitchen", "present": []}})))
            page.route("**/api/orwell/ceremony-continue", lambda r: r.fulfill(**_j(press_response)))
            page.goto(fe, wait_until="domcontentloaded")
            page.wait_for_selector("#chat-history", timeout=15000)
            page.evaluate("""(busy) => { window.__cues = []; window.__announced = 0;
                window.addEventListener('orwell:announcements', () => { window.__announced += 1; });
                window.chatModule = window.chatModule || {};
                window.chatModule.sendHiddenCue = (t) => { window.__cues.push(t); return true; };
                window.chatModule.hasActiveStream = () => busy;
                window.sessionModule = window.sessionModule || {};
                window.sessionModule.getCurrentSessionId = () => 'sid'; }""", active_stream)
            page.evaluate("""(p) => window.dispatchEvent(new CustomEvent('orwell:pending', { detail: { pending: p } }))""", BALLOT)
            page.wait_for_selector(".odec-watch", timeout=10000)
            page.click(".odec-watch button.odec-confirm")
            for _ in range(40):
                if page.evaluate("document.querySelectorAll('.odec-watch').length") == 0:
                    break
                page.wait_for_timeout(100)
            page.wait_for_timeout(300)
            return page.evaluate("({cues: window.__cues, announced: window.__announced})")
        finally:
            browser.close()


def test_a_press_with_the_beat_fact_sends_one_hidden_cue_and_still_announces(fe):
    out = _run(fe, {"beatSeq": 9, "voteBeatCue": True, "eviction": {"voteBeat": BEAT}, "announcements": [{"id": "a1", "headline": "a vote to evict a nominee."}]})
    assert len(out["cues"]) == 1, out
    assert out["cues"][0].startswith("(Production cue"), out   # hidden on every device by the cue envelope, never a player line
    assert out["announced"] == 1, out                         # ORW-703: the chyron stays the one source of the board fact


def test_a_press_without_the_beat_fact_sends_nothing(fe):
    out = _run(fe, {"beatSeq": 9, "announcements": [{"id": "a1", "headline": "a vote to evict a nominee."}]})
    assert out["cues"] == [], out
    assert out["announced"] == 1, out


def test_a_stale_refused_press_shows_a_beat_fact_but_sends_no_cue(fe):
    """A press the engine refused as stale returns the current state (which still shows the last press's beat fact) but the server did not arm a cue: the page must send none."""
    out = _run(fe, {"beatSeq": 9, "eviction": {"voteBeat": BEAT}})
    assert out["cues"] == [], out


def test_a_press_while_a_beat_is_streaming_piles_no_second_cue(fe):
    out = _run(fe, {"beatSeq": 9, "voteBeatCue": True, "eviction": {"voteBeat": BEAT}}, active_stream=True)
    assert out["cues"] == [], out

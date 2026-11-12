"""ORW-246 (Ryne, phone playtest: the room banner is "not accurate or always present"), real browser at 320/390/768.
The strip must stay up during play: an empty room reads "Just you here" (it used to unmount), a failed poll keeps the last
strip (it used to blank), the chips match the engine's whereabouts, and it updates on orwell:gamechanged. Own module so
conftest routes it to the serial browser lane."""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))

WIDTHS = [("tiny-320", 320, 640), ("phone-390", 390, 844), ("tablet-768", 768, 1024)]


def _j(o, status=200):
    return {"status": status, "content_type": "application/json", "body": json.dumps(o)}


@pytest.fixture(scope="module")
def fe():
    import responsive_matrix as rm
    proc = rm.boot_fe()
    yield rm.FE
    rm.stop_fe(proc)


def _strip(page):
    return page.evaluate("""() => { const s = document.getElementById('orwell-room-strip');
      if (!s) return null; const b = s.getBoundingClientRect();
      const input = document.querySelector('#chat-input, textarea'); const ib = input ? input.getBoundingClientRect() : null;
      return { shown: b.width > 0 && b.height > 0, names: [...s.querySelectorAll('.ow-mono-face, img')].length,
               alone: !!s.querySelector('.ors-alone'), right: b.right, overlapsInput: !!(ib && ib.width && b.bottom > ib.top && b.top < ib.bottom) }; }""")


@pytest.mark.parametrize("name,w,h", WIDTHS)
def test_orw246_strip_stays_present_accurate_and_live(fe, name, w, h):
    sync_api = pytest.importorskip("playwright.sync_api")
    state = {"present": [{"id": "a", "name": "Ann"}, {"id": "b", "name": "Bo"}], "fail": False}

    def where(route):
        if state["fail"]:
            return route.fulfill(**_j({"error": "blip"}, 500))
        route.fulfill(**_j({"whereabouts": {"room": "kitchen", "present": state["present"]}}))

    with sync_api.sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_context(viewport={"width": w, "height": h}, has_touch=w < 800).new_page()
            page.route("**/api/orwell/state", lambda r: r.fulfill(**_j({"started": True, "asleep": []})))
            page.route("**/api/orwell/whereabouts", where)
            page.route("**/api/orwell/status", lambda r: r.fulfill(**_j({})))  # no engine behind the stub: unstubbed, this call hangs for seconds
            page.route("**/api/orwell/roster", lambda r: r.fulfill(**_j({"roster": []})))
            page.goto(fe, wait_until="domcontentloaded")
            page.wait_for_selector("#orwell-room-strip .ors-chip", timeout=15000)
            s = _strip(page)
            assert s["shown"] and s["names"] >= 2 and s["right"] <= w and not s["overlapsInput"], s  # same people as the engine, in view
            state["present"] = [{"id": "b", "name": "Bo"}]  # Ann walks out: the strip follows on the live signal
            page.evaluate("window.dispatchEvent(new CustomEvent('orwell:gamechanged'))")
            for _ in range(40):  # (wait_for_function evals a string, which the page CSP refuses - poll with evaluate)
                if page.evaluate("document.querySelectorAll('#orwell-room-strip .ors-chip:not(.ors-chip-leaving)').length") == 1:
                    break
                page.wait_for_timeout(200)
            else:
                raise AssertionError("the strip did not drop to one chip on the live signal")
            state["present"] = []  # alone: the strip stays, saying so (the last chip dims for one cycle first)
            for _ in range(2):
                page.evaluate("window.dispatchEvent(new CustomEvent('orwell:gamechanged'))")
                page.wait_for_timeout(700)
            page.wait_for_selector("#orwell-room-strip .ors-alone", timeout=8000)
            assert _strip(page)["shown"]
            state["present"] = [{"id": "a", "name": "Ann"}]
            page.evaluate("window.dispatchEvent(new CustomEvent('orwell:gamechanged'))")
            page.wait_for_selector("#orwell-room-strip .ors-chip", timeout=8000)
            state["fail"] = True  # a failed poll keeps the last strip
            page.evaluate("window.dispatchEvent(new CustomEvent('orwell:gamechanged'))")
            page.wait_for_timeout(1200)
            assert _strip(page)["shown"], "a failed poll must not blank the strip"
        finally:
            browser.close()

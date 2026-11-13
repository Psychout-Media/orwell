"""ORW-309 (phone play): every card the engine stages, at phone width. Ryne plays only on his phone.

The cards are REAL engine pending views (captured from played seasons through the player channel: tests/fixtures/orw309_pendings.json; Vault-free by construction, they are what the player is shown) plus the
staged ceremony watch steps. Each is mounted through the front end's own `orwell:pending` seam at 390x844 with touch and audited with the responsive matrix's measurable checks (page overflow, surface overlap,
crowding, 44 px touch targets); then the height is shrunk to 440 (the on-screen keyboard up) and the composer must stay visible and uncovered by the card's VISIBLE area (the above-composer stack is capped at 40vh
and scrolls inside that cap by design, so raw bounding boxes would flag a card that is merely scrollable), with no sideways page scroll. No pixel comparison (the 2026-07-21 owner directive stands).
Findings of the pass (2026-11-13): nothing cramped, hidden or untappable at 390x844 for any card kind; with the keyboard up the Continue / Confirm button of a tall card sits below the stack's cap and is reached by
scrolling inside it, which is the designed trade (the composer keeps its real estate). Roles only; houseguests are generic ids."""
from __future__ import annotations

import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "scripts"))

pytestmark = pytest.mark.browser

PHONE = {"width": 390, "height": 844}
KEYBOARD_UP = {"width": 390, "height": 440}

with open(os.path.join(HERE, "fixtures", "orw309_pendings.json"), encoding="utf-8") as _fh:
    PENDINGS = json.load(_fh)


@pytest.fixture(scope="module")
def fe():
    import responsive_matrix as rm
    proc = rm.boot_fe()
    yield rm.FE
    rm.stop_fe(proc)


def _j(o):
    return {"status": 200, "content_type": "application/json", "body": json.dumps(o)}


def _open(pw, fe, pending=None):
    import responsive_matrix as rm
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport=PHONE, is_mobile=True, has_touch=True, device_scale_factor=3)
    page = ctx.new_page()
    page.route("**/api/orwell/state", lambda r: r.fulfill(**_j({"started": True, "asleep": []})))
    page.route("**/api/orwell/status", lambda r: r.fulfill(**_j({})))
    page.route("**/api/orwell/roster", lambda r: r.fulfill(**_j({"roster": []})))
    page.route("**/api/orwell/whereabouts", lambda r: r.fulfill(**_j({"whereabouts": {"room": "kitchen", "present": []}})))
    page.goto(fe, wait_until="domcontentloaded")
    page.wait_for_selector("#chat-history", timeout=15000)
    rm.quiesce_motion(page)
    if pending is not None:
        page.evaluate("(p) => window.dispatchEvent(new CustomEvent('orwell:pending', { detail: { pending: p } }))", pending)
        page.wait_for_selector(".odec", timeout=10000)
    return browser, page


# The composer must stay visible and uncovered by the card's VISIBLE (clipped) area, and the page must not scroll sideways.
_KEYBOARD_JS = """() => {
  const comp = document.querySelector('#message'); if (!comp) return { problems: ['no composer'] };
  comp.focus();
  const c = comp.getBoundingClientRect(); const vw = innerWidth, vh = innerHeight; const out = [];
  if (c.bottom > vh + 1 || c.top < 0 || c.right > vw + 1 || c.left < -1) out.push('composer outside the visible area ' + JSON.stringify([c.top, c.bottom, vh]));
  for (const k of document.querySelectorAll('.odec, #orwell-decision-card')) {
    if (k.offsetParent === null && getComputedStyle(k).position !== 'fixed') continue;
    const r = k.getBoundingClientRect(); let t = r.top, b = r.bottom, l = r.left, rt = r.right;
    for (let e = k.parentElement; e && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.overflowY !== 'visible' || cs.overflowX !== 'visible') { const q = e.getBoundingClientRect(); t = Math.max(t, q.top); b = Math.min(b, q.bottom); l = Math.max(l, q.left); rt = Math.min(rt, q.right); }
    }
    if (b > t && rt > l && l < c.right && rt > c.left && t < c.bottom && b > c.top) out.push('a card covers the composer: ' + (k.id || k.className));
  }
  const over = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  if (over > 1) out.push('page scrolls horizontally by ' + over);
  return { problems: out };
}"""


def _audit(page, label, keyboard=True):
    import responsive_matrix as rm
    before = len(rm.failures)
    rm.audit_page(page, "phone-390", PHONE["width"], PHONE["height"], True, True)
    found = [f"[{label}] {f}" for f in rm.failures[before:]]
    del rm.failures[before:]
    if keyboard:
        page.set_viewport_size(KEYBOARD_UP)
        page.wait_for_timeout(400)
        found += [f"[{label}] keyboard-up: {p}" for p in page.evaluate(_KEYBOARD_JS)["problems"]]
        page.set_viewport_size(PHONE)
        page.wait_for_timeout(200)
    return found


@pytest.mark.parametrize("key", sorted(PENDINGS))
def test_every_staged_card_is_visible_tappable_and_clear_of_the_composer_on_a_phone(fe, key):
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as pw:
        browser, page = _open(pw, fe, PENDINGS[key])
        try:
            found = _audit(page, key)
        finally:
            browser.close()
    assert not found, "phone-width problems found:\n" + "\n".join(found)


def test_the_phone_audit_goes_red_on_a_broken_phone_layout(fe):
    """The audit must not pass vacuously: a 20 px button (opting out of the app's own 44 px touch minimum), a card wider than the screen and a card parked over the composer each fail it."""
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as pw:
        browser, page = _open(pw, fe)
        try:
            assert _audit(page, "baseline") == [], "the empty phone page is clean"
            page.evaluate("""() => {
              const b = document.createElement('button'); b.textContent = 'tiny'; b.style.cssText = 'position:fixed;top:120px;left:10px;width:20px;height:20px;min-width:0;min-height:0;z-index:9';
              const w = document.createElement('div'); w.className = 'odec'; w.id = 'orwell-decision-card'; w.style.cssText = 'position:absolute;left:0;width:700px;bottom:0;height:120px;z-index:9;background:#444';
              w.innerHTML = '<button class="odec-confirm" style="width:30px;height:20px;min-width:0;min-height:0">ok</button>';
              document.body.append(b, w);
            }""")
            bad = "\n".join(_audit(page, "broken"))
        finally:
            browser.close()
    assert "touch" in bad, bad
    assert "overflow" in bad or "horizontally" in bad, bad
    assert "overlap" in bad or "covers the composer" in bad, bad

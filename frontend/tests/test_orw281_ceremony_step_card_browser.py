"""ORW-281, real browser: the ceremony-step WATCH card. The unit tests pin the source; this drives the real orwellDecision.js in Chromium.

A staged ceremony is a run of non-binding "watch" steps (pending kind `ceremony-step`, Vault-free `text`) the player moves along with a Continue button. The card must
show the ceremony title with "step of total" (the total can GROW mid-ceremony, 3 -> 4), the step's text, be a role=group non-binding card (never the form of a binding
decision), and Continue must POST /api/orwell/ceremony-continue exactly once, remove the card, and mount the NEXT step from the response. API calls are stubbed, so
this proves the front-end half only; the engine half is A's. Own module so conftest routes it to the serial browser lane. Roles only."""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))


@pytest.fixture(scope="module")
def fe():
    import responsive_matrix as rm
    proc = rm.boot_fe()
    yield rm.FE
    rm.stop_fe(proc)


def _j(o, status=200):
    return {"status": status, "content_type": "application/json", "body": json.dumps(o)}


def _step(step, of, text, kind="veto-ceremony"):
    return {"kind": "ceremony-step", "id": f"{kind}-{step}", "binding": False, "text": text,
            "ceremony": {"kind": kind, "step": step, "of": of, "stepId": f"{kind}-{step}"}}


def _card(page):
    return page.evaluate("""() => { const c = document.querySelector('.odec-watch'); if (!c) return null;
      return { role: c.getAttribute('role'), binding: c.dataset.binding, step: c.dataset.step, ceremony: c.dataset.ceremony,
               title: (c.querySelector('.odec-title') || {}).textContent, text: (c.querySelector('.odec-note') || {}).textContent,
               button: (c.querySelector('button.odec-confirm') || {}).textContent, forms: document.querySelectorAll('.odec[role=form]').length }; }""")


def test_a_ceremony_step_card_continues_to_the_next_step_and_the_total_can_grow(fe):
    sync_api = pytest.importorskip("playwright.sync_api")
    posts = []
    nxt = _step(3, 4, "The host turns to the nominee.")   # the total grew from 3 to 4 between steps

    def cont(route):
        posts.append(route.request.method)
        route.fulfill(**_j({"beatSeq": 12, "pending": nxt}))

    with sync_api.sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True).new_page()
            page.route("**/api/orwell/state", lambda r: r.fulfill(**_j({"started": True, "asleep": []})))
            page.route("**/api/orwell/status", lambda r: r.fulfill(**_j({})))
            page.route("**/api/orwell/roster", lambda r: r.fulfill(**_j({"roster": []})))
            page.route("**/api/orwell/whereabouts", lambda r: r.fulfill(**_j({"whereabouts": {"room": "kitchen", "present": []}})))
            page.route("**/api/orwell/ceremony-continue", cont)
            page.goto(fe, wait_until="domcontentloaded")
            page.wait_for_selector("#chat-history", timeout=15000)
            page.evaluate("""(p) => window.dispatchEvent(new CustomEvent('orwell:pending', { detail: { pending: p } }))""",
                          _step(2, 3, "The host reads the veto result aloud."))
            page.wait_for_selector(".odec-watch", timeout=10000)
            c = _card(page)
            assert c["role"] == "group" and c["binding"] == "false" and c["forms"] == 0, c        # a watch step is not a form
            assert c["ceremony"] == "veto-ceremony" and c["step"] == "2", c
            assert "Veto ceremony" in c["title"] and "2 of 3" in c["title"], c
            assert c["text"] == "The host reads the veto result aloud." and c["button"] == "Continue", c
            page.click(".odec-watch button.odec-confirm")
            for _ in range(40):  # (wait_for_function evals a string, which the page CSP refuses - poll with evaluate)
                c2 = _card(page)
                if c2 and "3 of 4" in (c2["title"] or ""):
                    break
                page.wait_for_timeout(200)
            else:
                raise AssertionError(f"the next step did not mount with the grown total: {_card(page)}")
            assert posts == ["POST"], posts                                                     # exactly one continue per click
            assert c2["text"] == "The host turns to the nominee." and c2["step"] == "3", c2
            assert page.evaluate("document.querySelectorAll('.odec-watch').length") == 1        # the old card was replaced, not stacked
        finally:
            browser.close()

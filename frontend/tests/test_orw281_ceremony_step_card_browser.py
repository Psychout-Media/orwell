"""ORW-281, real browser: the ceremony-step WATCH card. The unit tests pin the source; this drives the real orwellDecision.js in Chromium.

A staged ceremony is a run of non-binding "watch" steps (pending kind `ceremony-step`, Vault-free `text`) the player moves along with a Continue button. The card must
show the ceremony title with "step of total" (the total can GROW mid-ceremony, 3 -> 4), the step's text, be a role=group non-binding card (never the form of a binding
decision), and Continue must POST /api/orwell/ceremony-continue exactly once, remove the card, and mount the NEXT step from the response. API calls are stubbed, so
this proves the front-end half only; the engine half is A's. Own module so conftest routes it to the serial browser lane. Roles only."""
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
    first = _step(2, 3, "The host reads the veto result aloud.")
    engine = {"pending": first}   # the engine's truth: the ceremony card follows it (ORW-298), so the status stub must say the same thing the test injects

    def cont(route):
        posts.append(route.request.method)
        engine["pending"] = nxt
        route.fulfill(**_j({"beatSeq": 12, "pending": nxt}))

    with sync_api.sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True).new_page()
            page.route("**/api/orwell/state", lambda r: r.fulfill(**_j({"started": True, "asleep": []})))
            # Not `{}`: a watch card follows the engine's pending (_dropStaleWatchCard), so a boot/backstop status read that lands AFTER the injected card and says "no pending" removes it
            # under the click ("element was detached", the CI flake at -n 2). The stub answers with the same pending the test shows.
            page.route("**/api/orwell/status", lambda r: r.fulfill(**_j({"pending": engine["pending"]})))
            page.route("**/api/orwell/roster", lambda r: r.fulfill(**_j({"roster": []})))
            page.route("**/api/orwell/whereabouts", lambda r: r.fulfill(**_j({"whereabouts": {"room": "kitchen", "present": []}})))
            page.route("**/api/orwell/ceremony-continue", cont)
            page.goto(fe, wait_until="domcontentloaded")
            page.wait_for_selector("#chat-history", timeout=15000)
            page.evaluate("""(p) => window.dispatchEvent(new CustomEvent('orwell:pending', { detail: { pending: p } }))""",
                          first)
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


def test_the_same_step_announced_again_leaves_the_watch_card_alone(fe):
    """ORW-471: the boot rearm, a socket frame and the backstop poll all re-announce the same pending. A watch card already showing that step must stay the SAME element (no teardown and
    rebuild under the player's click); a different step still replaces it."""
    sync_api = pytest.importorskip("playwright.sync_api")
    first = _step(2, 3, "The host reads the veto result aloud.")
    with sync_api.sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True).new_page()
            page.route("**/api/orwell/state", lambda r: r.fulfill(**_j({"started": True, "asleep": []})))
            page.route("**/api/orwell/status", lambda r: r.fulfill(**_j({"pending": first})))
            page.route("**/api/orwell/roster", lambda r: r.fulfill(**_j({"roster": []})))
            page.route("**/api/orwell/whereabouts", lambda r: r.fulfill(**_j({"whereabouts": {"room": "kitchen", "present": []}})))
            page.goto(fe, wait_until="domcontentloaded")
            page.wait_for_selector("#chat-history", timeout=15000)
            fire = "(p) => window.dispatchEvent(new CustomEvent('orwell:pending', { detail: { pending: p } }))"
            page.evaluate(fire, first)
            page.wait_for_selector(".odec-watch", timeout=10000)
            page.evaluate("window.__card = document.getElementById('orwell-decision-card')")
            for _ in range(3):
                page.evaluate(fire, first)
            assert page.evaluate("document.getElementById('orwell-decision-card') === window.__card"), "the same step rebuilt the card"
            page.evaluate(fire, _step(3, 3, "The host turns to the nominee."))
            assert page.evaluate("document.getElementById('orwell-decision-card') !== window.__card"), "a different step must replace the card"
            assert page.evaluate("(document.querySelector('.odec-watch') || {}).dataset?.step") == "3", "the replacement card must exist and show the new step"
        finally:
            browser.close()


# A status read that STARTED before the step moved on and LANDS after it: the page's own fetch is delayed in-page (a route handler that sleeps would block the click).
_DELAY_STATUS = """(() => {
  const real = window.fetch.bind(window);
  window.fetch = async (url, opts) => {
    const r = await real(url, opts);
    if (String(url).includes('/api/orwell/status') && window.__delayStatusMs) { await new Promise((res) => setTimeout(res, window.__delayStatusMs)); }
    return r;
  };
})()"""


def _watch_page(p, status_pending, cont_pending=None):
    page = p.chromium.launch().new_context(viewport={"width": 390, "height": 844}, has_touch=True).new_page()
    page.add_init_script(_DELAY_STATUS)
    page.route("**/api/orwell/state", lambda r: r.fulfill(**_j({"started": True, "asleep": []})))
    page.route("**/api/orwell/status", lambda r: r.fulfill(**_j({"pending": status_pending})))
    page.route("**/api/orwell/roster", lambda r: r.fulfill(**_j({"roster": []})))
    page.route("**/api/orwell/whereabouts", lambda r: r.fulfill(**_j({"whereabouts": {"room": "kitchen", "present": []}})))
    if cont_pending is not None:
        page.route("**/api/orwell/ceremony-continue", lambda r: r.fulfill(**_j({"beatSeq": 12, "pending": cont_pending})))
    return page


_FIRE = "(p) => window.dispatchEvent(new CustomEvent('orwell:pending', { detail: { pending: p } }))"
_STEP_ON_SCREEN = "(document.querySelector('.odec-watch') || {}).dataset?.step"


def test_a_late_read_of_a_step_already_continued_neither_drops_the_next_card_nor_brings_the_old_one_back(fe):
    """#2636 / #2823 review (P1): a status read that started BEFORE the player pressed Continue and still names the finished step lands AFTER the next step is up. It must change
    nothing: the live next-step card stays and the finished step is never mounted again."""
    sync_api = pytest.importorskip("playwright.sync_api")
    first = _step(2, 3, "The host reads the veto result aloud.")
    nxt = _step(3, 3, "The host turns to the nominee.")
    with sync_api.sync_playwright() as p:
        page = _watch_page(p, first, nxt)
        try:
            page.goto(fe, wait_until="domcontentloaded")
            page.wait_for_selector("#chat-history", timeout=15000)
            page.evaluate(_FIRE, first)
            page.wait_for_selector(".odec-watch[data-step='2']", timeout=10000)
            page.wait_for_timeout(1500)                                              # let the boot rearm settle (its reads agree with the card)
            page.evaluate("window.__delayStatusMs = 2500")                           # the next status read will land 2.5 s late ...
            page.evaluate("window.dispatchEvent(new Event('orwell:gamechanged'))")   # ... and it starts NOW, before the click
            page.click(".odec-watch button.odec-confirm")
            page.wait_for_selector(".odec-watch[data-step='3']", timeout=10000)
            page.wait_for_timeout(3500)                                              # the stale read (naming step 2) has landed
            assert page.evaluate(_STEP_ON_SCREEN) == "3", "the stale read dropped the next card or brought the finished step back"
        finally:
            page.context.browser.close()


def test_a_typed_next_that_moves_the_step_on_is_remembered_too(fe):
    """#2823 review (P1): a typed "next" advances a watch step without the button. When the engine's next step replaces the card, the step it replaced counts as done, so a late
    read naming it changes nothing."""
    sync_api = pytest.importorskip("playwright.sync_api")
    first = _step(2, 3, "The host reads the veto result aloud.")
    nxt = _step(3, 3, "The host turns to the nominee.")
    with sync_api.sync_playwright() as p:
        page = _watch_page(p, first)
        try:
            page.goto(fe, wait_until="domcontentloaded")
            page.wait_for_selector("#chat-history", timeout=15000)
            page.evaluate(_FIRE, first)
            page.wait_for_selector(".odec-watch[data-step='2']", timeout=10000)
            page.evaluate(_FIRE, nxt)                                                # the engine moved on (typed "next"): its new pending arrives
            page.wait_for_selector(".odec-watch[data-step='3']", timeout=10000)
            page.evaluate(_FIRE, first)                                              # a late frame still naming the old step
            page.evaluate("window.dispatchEvent(new Event('orwell:gamechanged'))")   # and a rearm whose status read is stale
            page.wait_for_timeout(1200)
            assert page.evaluate(_STEP_ON_SCREEN) == "3"
        finally:
            page.context.browser.close()


def test_next_weeks_same_step_still_mounts(fe):
    """#2823 review (P1): ceremony step numbers restart every week and the engine's stepId names the kind of step, not the occurrence. A finished step is remembered only for a
    short window, so the same kind and step in a LATER ceremony mounts normally."""
    sync_api = pytest.importorskip("playwright.sync_api")
    first = _step(2, 3, "The host reads the veto result aloud.")
    nxt = _step(3, 3, "The host turns to the nominee.")
    with sync_api.sync_playwright() as p:
        page = _watch_page(p, first, nxt)
        try:
            page.clock.install()
            page.goto(fe, wait_until="domcontentloaded")
            page.wait_for_selector("#chat-history", timeout=15000)
            page.evaluate(_FIRE, first)
            page.wait_for_selector(".odec-watch[data-step='2']", timeout=10000)
            page.click(".odec-watch button.odec-confirm")
            page.wait_for_selector(".odec-watch[data-step='3']", timeout=10000)
            page.evaluate(_FIRE, None)                                               # the ceremony ends
            page.clock.fast_forward(60_000)                                          # a week of play later (well past the window)
            page.evaluate(_FIRE, first)                                              # the same kind and step, a new occurrence
            page.wait_for_selector(".odec-watch[data-step='2']", timeout=10000)
        finally:
            page.context.browser.close()


def test_a_status_read_that_lands_late_and_agrees_keeps_the_card_and_one_that_disagrees_drops_it(fe):
    """ORW-298 by design: the watch card follows the engine. A status answer that lands AFTER the card mounted (slow runner) and still shows the same step changes nothing; one that
    shows no pending removes the card. The first half is what the continue test above depends on; the second pins why its old `{}` stub raced."""
    sync_api = pytest.importorskip("playwright.sync_api")
    engine = {"pending": _step(2, 3, "The host reads the veto result aloud."), "hold": False}
    held = []

    def answer(route):
        route.fulfill(**_j({"pending": engine["pending"]} if engine["pending"] else {}))

    def status(route):
        # a slow runner: while `hold` is set the request is parked (not answered) and the TEST releases it later. No sleep in the route callback, which would block the synchronous dispatcher (review of #2800).
        if engine["hold"]:
            held.append(route)
            return
        answer(route)

    with sync_api.sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True).new_page()
            page.route("**/api/orwell/state", lambda r: r.fulfill(**_j({"started": True, "asleep": []})))
            page.route("**/api/orwell/status", status)
            page.route("**/api/orwell/roster", lambda r: r.fulfill(**_j({"roster": []})))
            page.route("**/api/orwell/whereabouts", lambda r: r.fulfill(**_j({"whereabouts": {"room": "kitchen", "present": []}})))
            page.goto(fe, wait_until="domcontentloaded")
            page.wait_for_selector("#chat-history", timeout=15000)
            engine["hold"] = True
            page.evaluate("(p) => window.dispatchEvent(new CustomEvent('orwell:pending', { detail: { pending: p } }))", engine["pending"])
            page.wait_for_selector(".odec-watch", timeout=10000)
            page.evaluate("window.dispatchEvent(new CustomEvent('orwell:gamechanged'))")   # a status read starts now and is held until the test answers it
            for _ in range(50):
                if held:
                    break
                page.wait_for_timeout(100)
            assert held, "the status read must reach the route"
            for r in held:
                answer(r)     # the late answer lands now, long after the card is on screen
            held.clear()
            engine["hold"] = False
            frames(page, 180)   # an absence check, so a bounded window of the page's own frames, not a sleep
            assert page.evaluate("document.querySelectorAll('.odec-watch').length") == 1, "a late status that agrees must keep the card"
            engine["pending"] = None
            page.evaluate("window.dispatchEvent(new CustomEvent('orwell:gamechanged'))")
            for _ in range(40):
                if page.evaluate("document.querySelectorAll('.odec-watch').length") == 0:
                    break
                page.wait_for_timeout(200)
            else:
                raise AssertionError("a status that shows no pending must drop the watch card (ORW-298)")
        finally:
            browser.close()

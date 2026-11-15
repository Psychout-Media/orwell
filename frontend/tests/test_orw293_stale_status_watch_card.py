"""ORW-293 (the 'ceremony Continue card stranded' flake, Overseer B 11-14; reproduced 1 in 5 on the runner) - a status read that started BEFORE Continue must never re-mount the step Continue retired.

Root cause: orwellDecision.js re-arms the decision card from GET /api/orwell/status (`rearmFromStatus` on every `orwell:gamechanged`, the backstop poll, the 409 recovery). Nothing checked
that a read was still current when it landed. A read in flight when the player pressed Continue came back AFTER Continue had removed the card, still carrying the old step's pending,
and mounted it again ("Final 2 eviction - 2 of 2 - Continue" on screen with the engine already past it); its 5 s re-assert loop could even re-mount it after a newer read dropped it.

This test makes that ordering certain instead of rare: status reads issued before the press are held 3 s, reads after it are not. Real engine (staged finale save) + FE + stub + Chromium.
"""
from __future__ import annotations

import pytest

from _orw298_finale_support import (_launch, _open, _session, beat_seq, click_continue, finale_stack, no_watch_card, wait_beat_after, wait_card)

pytestmark = pytest.mark.browser

_HOLD_STATUS = """() => {
  if (window.__holdWrapped) return; window.__holdWrapped = true; window.__statusHoldMs = 0;
  const orig = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const hold = url.indexOf('/api/orwell/status') >= 0 ? window.__statusHoldMs : 0;
    const p = orig(input, init);
    return hold ? p.then(r => new Promise(res => setTimeout(() => res(r), hold))) : p;
  };
}"""


@pytest.mark.timeout(900)
def test_a_status_read_from_before_continue_never_brings_the_step_back():
    with finale_stack("npc") as stack:
        from playwright.sync_api import sync_playwright
        _session(stack, "o293-stale-status")
        with sync_playwright() as pw:
            b = _launch(pw)
            page = _open(b, stack)
            page.evaluate(_HOLD_STATUS)
            wait_card(page, "1 of 2")
            before = beat_seq(stack)
            click_continue(page)
            wait_beat_after(stack, before, "Continue on 1 of 2")
            wait_card(page, "2 of 2")
            # A re-arm read starts NOW (as any board-change push would start one) and is held; then the player presses Continue.
            page.evaluate("() => { window.__statusHoldMs = 3000; window.dispatchEvent(new Event('orwell:gamechanged')); }")
            page.wait_for_timeout(400)  # past platform.js's 250 ms debounce: the held read is in flight
            page.evaluate("() => { window.__statusHoldMs = 0; }")
            before = beat_seq(stack)
            click_continue(page)
            wait_beat_after(stack, before, "Continue on 2 of 2")
            page.wait_for_timeout(3500)  # the held read has landed by now
            no_watch_card(page, "after a status read from before Continue landed")
            b.close()

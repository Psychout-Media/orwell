"""ORW-974 (Fable's dev playtest 2026-11-19, screenshot t036): the "Welcome to the house - premiere week" card, stacked above the composer with the row of faces, covered most of the newest reply until it was
dismissed (the "scroll to newest" button showed 1). A card above the composer takes room from the chat area, but nothing moved the view: `scrollTop` stays where it was, so the tail of the newest reply slid
UNDER the card. The chat now re-pins to the bottom when its own height changes (a card mounting or growing, the composer growing) while the player is following the newest reply; a player who scrolled up to read
is never pulled down. Real engine + real FE + the scripted stub narrator + a real Chromium (the shared `_stack` fixture). Roles only."""
from __future__ import annotations

import pytest

from test_m0_3_midgen_join import STUB, _stack  # noqa: F401  (the shared real-stack fixture)
from test_p0h_day1_clock_e2e import _session
from test_orw191_golden_flows import AI_BUBBLE, COMPOSER, _launch, _open, _send, _wait_settled

pytestmark = pytest.mark.browser

LINES = [f"The house settles into its evening, line {i}, with the kitchen noise carrying down the hall. " for i in range(1, 46)] + ["And the newest line ends here."]  # streamed in chunks, as a real narrator does
TAIL = "And the newest line ends here."

_VISIBLE = """([tail]) => {
  const box = document.getElementById('chat-history');
  const msgs = Array.from(box.querySelectorAll('.msg.msg-ai')).filter(e => (e.textContent || '').includes(tail));
  const last = msgs[msgs.length - 1];
  if (!last) return { found: false };
  const b = box.getBoundingClientRect(), m = last.getBoundingClientRect();
  return { found: true, overshoot: Math.round(m.bottom - b.bottom), scrollTop: Math.round(box.scrollTop), room: Math.round(box.scrollHeight - box.clientHeight) };
}"""

_MOUNT_CARD = """([id, h]) => {
  const n = window.OrwellNoticeKit.create({ id, kind: 'guide', title: 'A tall card above the composer', dismissible: true, persistDismiss: false });
  n.ensure().innerHTML = '<div style="height:' + h + 'px">tall</div>';
  return true;
}"""


def _settle(page, follow=True):
    """Wait for the chat to come to rest (up to 20 s). With `follow` (the player is following) it rests only once the newest reply is fully in view: a position that merely paused for one poll mid-catch-up on a slow page is
    not rest (ORW-996: the old rule "two equal polls" returned mid-way on CI's slow frames). A player who scrolled up (`follow=False`) rests when the position stops moving."""
    last = None
    for _ in range(67):
        page.wait_for_timeout(300)
        now = page.evaluate("() => { const b = document.getElementById('chat-history'); return [Math.round(b.scrollTop), Math.round(b.scrollHeight), Math.round(b.clientHeight)]; }")
        if follow and now[1] - now[2] - now[0] <= 3:
            return
        if not follow and now == last:
            return
        last = now


def test_a_card_mounting_above_the_composer_never_hides_the_newest_reply(_stack):  # noqa: F811
    from playwright.sync_api import sync_playwright
    _session(_stack, "orw974")
    with sync_playwright() as pw:
        browser = _launch(pw)
        page = _open(browser, _stack)
        STUB.script.append({"deltas": LINES, "delay": 0.04})
        n0 = len(STUB.script)
        _send(page, "I look around the house.", n0)
        _wait_settled(page, TAIL)
        _settle(page)
        before = page.evaluate(_VISIBLE, [TAIL])
        assert before["found"] and before["room"] > 100, f"the reply must overflow the chat for this test to mean anything: {before}"
        assert before["overshoot"] <= 3, f"the newest reply is fully visible before any card: {before}"

        # (1) a tall card mounts above the composer: the chat area shrinks by the card's height
        assert page.evaluate(_MOUNT_CARD, ["t974-a", 260])
        _settle(page)
        after = page.evaluate(_VISIBLE, [TAIL])
        assert after["overshoot"] <= 3, f"the card covers the tail of the newest reply (overshoot {after['overshoot']}px): {after}"

        # (2) the composer grows (a long draft): the chat area shrinks again, the newest reply stays in view
        page.fill(COMPOSER, "\n".join(f"a long draft, line {i}" for i in range(1, 9)))
        _settle(page)
        grown = page.evaluate(_VISIBLE, [TAIL])
        assert grown["overshoot"] <= 3, f"a growing composer covers the tail of the newest reply: {grown}"
        browser.close()


def test_a_player_who_scrolled_up_to_read_is_never_pulled_down_by_a_card(_stack):  # noqa: F811
    from playwright.sync_api import sync_playwright
    _session(_stack, "orw974b")
    with sync_playwright() as pw:
        browser = _launch(pw)
        page = _open(browser, _stack)
        STUB.script.append({"deltas": LINES, "delay": 0.04})
        n0 = len(STUB.script)
        _send(page, "I look around the house.", n0)
        _wait_settled(page, TAIL)
        _settle(page)
        # the player scrolls up to the top of the transcript (a real wheel event, so the follow rule sees a player scroll)
        page.evaluate("() => { const b = document.getElementById('chat-history'); b.scrollTop = 0; b.dispatchEvent(new Event('scroll')); }")
        page.wait_for_timeout(200)
        assert page.evaluate(_MOUNT_CARD, ["t974-b", 260])
        _settle(page, follow=False)
        top = page.evaluate("() => document.getElementById('chat-history').scrollTop")
        assert top < 40, f"a card pulled a reading player down the transcript (scrollTop {top})"
        browser.close()

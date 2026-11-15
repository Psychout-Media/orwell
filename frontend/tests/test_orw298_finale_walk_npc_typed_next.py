"""ORW-298 finale walk: npc typed next. One file per walk (own staged snapshot copy, own ports) so the CI duration balancer can shard them; the shared helpers live in _orw298_finale_support.py."""
from __future__ import annotations

import pytest

from _orw298_finale_support import *  # noqa: F401,F403
from _orw298_finale_support import (CARD, _N, _finish, _launch, _open, _session, beat_seq, click_continue, eng_state, finale_stack, no_watch_card, pending, player_final_hoh_walk,
                                    typed_next, wait_beat_after, wait_card, wait_until)

pytestmark = pytest.mark.browser  # (the conftest also auto-marks any module that calls sync_playwright)


@pytest.mark.timeout(1500)
def test_npc_final_hoh_continue_then_typed_next_then_the_whole_finale():
    """An NPC Final HOH (the player stays in as a finalist): the eviction decision step is answered by the Continue button, the result step by a typed 'next' (exactly one step), then the player's
    statement and jury-question answers, and the ballot-by-ballot reveal ending in the winner.

    FAILS TODAY (ORW-298 finding, kept as evidence): the typed 'next' DOES advance the engine exactly one step (the ceremony closes, pending becomes finale-statement), but the browser's
    'Final 2 eviction - 2 of 2' Continue card is NOT removed - it stays on screen (never self-heals; only a reload clears it) and it blocks the next real card (the statement card) from mounting.
    Pressing that stale Continue would advance the engine one more step."""
    with finale_stack("npc") as stack:
        from playwright.sync_api import sync_playwright
        _session(stack, "o298-npc")
        with sync_playwright() as pw:
            b = _launch(pw)
            page = _open(b, stack)
            c1 = wait_card(page, "Final 2 eviction \u00b7 1 of 2")
            assert c1["watch"] and c1["confirm"] == "Continue" and not c1["options"], c1
            assert not __import__("re").search(r"evict(s|ed) ", c1["text"]), f"the decision step must not name the result: {c1['text']!r}"
            before = beat_seq(stack)
            click_continue(page)                                   # (a) the Continue button -> /api/orwell/ceremony-continue
            wait_beat_after(stack, before, "Continue on the decision step")
            c2 = wait_card(page, "2 of 2")
            p2 = pending(stack)
            assert p2 and p2["kind"] == "ceremony-step" and p2["ceremony"]["stepId"] == "result", p2
            before = beat_seq(stack)
            typed_next(page, stack)                                # (b) a typed 'next' advances exactly ONE step: the result step closes, nothing else is skipped
            wait_beat_after(stack, before, "typed next on the result step")
            no_watch_card(page, "after the result step")
            p3 = pending(stack)
            assert not p3 or p3["kind"] != "ceremony-step", f"the ceremony must be closed after the result: {p3}"
            assert (eng_state(stack).get("phase") or "").startswith("finale"), eng_state(stack).get("phase")
            trace = []
            _finish(page, stack, trace, want_kinds=("finale-statement", "finale-answer"), forbid_kinds=("juror-vote", "juror-question"))
            b.close()

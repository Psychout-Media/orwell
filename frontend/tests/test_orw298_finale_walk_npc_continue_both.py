"""ORW-298 finale walk: npc continue both. One file per walk (own staged snapshot copy, own ports) so the CI duration balancer can shard them; the shared helpers live in _orw298_finale_support.py."""
from __future__ import annotations

import pytest

from _orw298_finale_support import *  # noqa: F401,F403
from _orw298_finale_support import (CARD, _N, _finish, _launch, _open, _session, beat_seq, click_continue, eng_state, finale_stack, no_watch_card, pending, player_final_hoh_walk,
                                    typed_next, wait_beat_after, wait_card, wait_until)

pytestmark = pytest.mark.browser  # (the conftest also auto-marks any module that calls sync_playwright)


@pytest.mark.timeout(1500)
def test_npc_final_hoh_continue_on_both_steps_then_the_whole_finale():
    """The same NPC Final HOH walk with the Continue button on BOTH ceremony steps (the typed-'next' variant above is the one that fails today: see its docstring). Keeps the rest of the finale covered."""
    with finale_stack("npc") as stack:
        from playwright.sync_api import sync_playwright
        _session(stack, "o298-npc-continue")
        with sync_playwright() as pw:
            b = _launch(pw)
            page = _open(b, stack)
            wait_card(page, "1 of 2")
            for step in ("1 of 2", "2 of 2"):
                wait_card(page, step)
                before = beat_seq(stack)
                click_continue(page)
                wait_beat_after(stack, before, f"Continue on {step}")
            no_watch_card(page, "after the result step")
            _finish(page, stack, [], want_kinds=("finale-statement", "finale-answer"), forbid_kinds=("juror-vote", "juror-question"))
            b.close()


def player_final_hoh_walk(strict):
    with finale_stack("player") as stack:
        from playwright.sync_api import sync_playwright
        _session(stack, "o298-player")
        with sync_playwright() as pw:
            b = _launch(pw)
            page = _open(b, stack)
            if pending(stack) is None:  # the staged HOH is crowned and nothing is pending: the first player turn opens the choice
                typed_next(page, stack)
            c = wait_card(page, "Final 3")
            assert not c["watch"] and c["binding"] == "true" and len(c["options"]) == 2 and c["confirmDisabled"], c
            assert "1 of 2" in c["title"], c["title"]
            before = beat_seq(stack)
            page.click(f"{CARD} .odec-opt")
            page.click(f"{CARD} .odec-confirm")
            wait_beat_after(stack, before, "the Final 2 choice")
            c2 = wait_card(page, "2 of 2")
            assert c2["watch"] and c2["confirm"] == "Continue", c2
            before = beat_seq(stack)
            click_continue(page)
            if strict:
                wait_beat_after(stack, before, "ONE Continue press on the result step")
            else:  # tolerate the swallowed first press (finding 2) so the rest of the walk is still covered
                for _ in range(3):
                    try:
                        wait_until(lambda: (beat_seq(stack) or 0) > before, "Continue", timeout_s=6)
                        break
                    except AssertionError:
                        click_continue(page)
                else:
                    raise AssertionError("Continue never advanced the result step in three presses")
            no_watch_card(page, "after the result step")
            _finish(page, stack, [], want_kinds=("finale-statement", "finale-answer"), forbid_kinds=("juror-vote",))
            b.close()

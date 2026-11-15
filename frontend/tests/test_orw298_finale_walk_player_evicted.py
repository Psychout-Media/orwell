"""ORW-298 finale walk: player evicted. One file per walk (own staged snapshot copy, own ports) so the CI duration balancer can shard them; the shared helpers live in _orw298_finale_support.py."""
from __future__ import annotations

import pytest

from _orw298_finale_support import *  # noqa: F401,F403
from _orw298_finale_support import (CARD, _N, _finish, _launch, _open, _session, beat_seq, click_continue, eng_state, finale_stack, no_watch_card, pending, player_final_hoh_walk,
                                    typed_next, wait_beat_after, wait_card, wait_until)

pytestmark = pytest.mark.browser  # (the conftest also auto-marks any module that calls sync_playwright)


@pytest.mark.timeout(1500)
def test_player_evicted_at_the_final_3_leaves_no_stranded_continue():
    """The Final HOH evicts the player: the decision step's Continue publishes it, and NOTHING is left to press (no result step, no ceremony left open); the player sits the jury and votes."""
    with finale_stack("evicted") as stack:
        from playwright.sync_api import sync_playwright
        _session(stack, "o298-evicted")
        with sync_playwright() as pw:
            b = _launch(pw)
            page = _open(b, stack)
            wait_card(page, "Final 2 eviction \u00b7 1 of 2")
            before = beat_seq(stack)
            click_continue(page)
            wait_beat_after(stack, before, "Continue on the decision step")
            no_watch_card(page, "after the player's own eviction was published")
            p = pending(stack)
            assert not p or p["kind"] != "ceremony-step", f"a ceremony-step is left open after the player's eviction: {p}"
            st = eng_state(stack)
            assert (st.get("player") or {}).get("status") not in (None, "active"), f"the player was not evicted: {st.get('player')}"
            trace = []
            _finish(page, stack, trace, want_kinds=("juror-vote",), forbid_kinds=("finale-statement", "finale-answer"))
            b.close()

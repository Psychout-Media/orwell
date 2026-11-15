"""ORW-298 finale walk: player juror. One file per walk (own staged snapshot copy, own ports) so the CI duration balancer can shard them; the shared helpers live in _orw298_finale_support.py."""
from __future__ import annotations

import pytest

from _orw298_finale_support import *  # noqa: F401,F403
from _orw298_finale_support import (CARD, _N, _finish, _launch, _open, _session, beat_seq, click_continue, eng_state, finale_stack, no_watch_card, pending, player_final_hoh_walk,
                                    typed_next, wait_beat_after, wait_card, wait_until)

pytestmark = pytest.mark.browser  # (the conftest also auto-marks any module that calls sync_playwright)


@pytest.mark.timeout(1500)
def test_player_as_a_juror_asks_and_votes():
    """The player was evicted earlier and sits on the jury: the Final HOH's eviction runs without them, then the player's own jury question card and juror-vote card, then the reveal and the winner."""
    with finale_stack("juror") as stack:
        from playwright.sync_api import sync_playwright
        _session(stack, "o298-juror")
        with sync_playwright() as pw:
            b = _launch(pw)
            page = _open(b, stack)
            trace = []
            _finish(page, stack, trace, want_kinds=("juror-vote",), forbid_kinds=("finale-statement", "finale-answer"))
            print("JUROR TRACE kinds:", [t[0] for t in trace if t[0] != "next"])
            b.close()

"""ORW-298 finale walk: player choose card. One file per walk (own staged snapshot copy, own ports) so the CI duration balancer can shard them; the shared helpers live in _orw298_finale_support.py."""
from __future__ import annotations

import pytest

from _orw298_finale_support import *  # noqa: F401,F403
from _orw298_finale_support import (CARD, _N, _finish, _launch, _open, _session, beat_seq, click_continue, eng_state, finale_stack, no_watch_card, pending, player_final_hoh_walk,
                                    typed_next, wait_beat_after, wait_card, wait_until)

pytestmark = pytest.mark.browser  # (the conftest also auto-marks any module that calls sync_playwright)


@pytest.mark.timeout(1500)
def test_player_final_hoh_choose_card_then_result_then_the_finale():
    """The player is the Final HOH: the binding 'final-eviction' choose card (Confirm disabled until a pick), then the result step (ONE Continue press), then the finale to the winner.

    (ORW-298 finding 2, fixed): the first Continue press on the result step right after the choose card is swallowed - POST /api/orwell/ceremony-continue answers 200 with the
    UNCHANGED view (same beatSeq, same result step; the stale-beat reconcile path returned the current state instead of advancing), the card stays, and only a second press advances."""
    player_final_hoh_walk(strict=True)

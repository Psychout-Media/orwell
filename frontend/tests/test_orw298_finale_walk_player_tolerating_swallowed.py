"""ORW-298 finale walk: player tolerating swallowed. One file per walk (own staged snapshot copy, own ports) so the CI duration balancer can shard them; the shared helpers live in _orw298_finale_support.py."""
from __future__ import annotations

import pytest

from _orw298_finale_support import *  # noqa: F401,F403
from _orw298_finale_support import (CARD, _N, _finish, _launch, _open, _session, beat_seq, click_continue, eng_state, finale_stack, no_watch_card, pending, player_final_hoh_walk,
                                    typed_next, wait_beat_after, wait_card, wait_until)

pytestmark = pytest.mark.browser  # (the conftest also auto-marks any module that calls sync_playwright)


@pytest.mark.timeout(1500)
def test_player_final_hoh_walk_tolerating_a_swallowed_first_continue():
    """The same player-Final-HOH walk, re-pressing Continue when the first press is swallowed (finding 2 above), so the statement / answer / reveal half is still walked."""
    player_final_hoh_walk(strict=False)

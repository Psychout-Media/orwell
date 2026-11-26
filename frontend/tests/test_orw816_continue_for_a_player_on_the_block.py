"""ORW-816 (0047 eviction night, item 1): a REAL-STACK test of Continue for a player ON THE BLOCK. Real engine (dist/main.js) + real FE + a scripted fake narrator; the seeded season whose NPC HOH puts the
player on the block (the same walk as the A64 loop). The walk stops where the eviction ceremony opens; the test then presses Continue (advanceGame, the press the card sends) one step at a time. No state is set by hand.
Checked: the player has NO eviction-vote card (they cannot vote); every press moves the ceremony (revealed ballots never go down, the card is a ceremony-step until the result); the ballots read one per press and
never all at once on the first press; the ceremony ends with exactly one of the final nominees out; the sealed ballots stay sealed (COUNTS only, never a voter). Roles only."""
from __future__ import annotations

import pytest

from test_m0_3_midgen_join import _stack  # noqa: F401  (the shared real-stack fixture)
from test_p0h_day1_clock_e2e import _schedule, _engine
from _a64_walk import NOMINEE_SEEDS, _walk_seeded_week, _roles

pytestmark = pytest.mark.browser


def _read(stack):
    _, st = _schedule(stack)
    ev = st.get("eviction") or {}
    return st, {"pending": (st.get("pending") or {}).get("kind"), "revealed": len(ev.get("votesRevealed") or []), "roles": _roles(st)}


def test_continue_walks_a_player_on_the_block_through_every_ballot_to_the_result(_stack):  # noqa: F811
    _sid, obs = _walk_seeded_week(_stack, NOMINEE_SEEDS, "block", "orw816", stop_at_eviction_ceremony=True)
    st, now = _read(_stack)
    assert now["pending"] == "ceremony-step" and now["roles"]["cer"] == "eviction", f"the walk did not stop at the eviction ceremony: {now}"
    assert now["roles"]["me"] in now["roles"]["nominees"], f"the player is not on the block: {now}"
    assert not now["roles"]["out"], f"someone had already left: {now}"
    first_reveal = None
    presses = 0
    last = now["revealed"]
    while presses < 40:
        assert now["pending"] != "eviction-vote", f"a player on the block was handed an eviction-vote card: {now}"
        if now["roles"]["out"]:
            break
        _engine(_stack, "advanceGame", {})
        presses += 1
        st, now = _read(_stack)
        assert now["revealed"] >= last, f"the revealed ballots went down on press {presses}: {last} -> {now['revealed']}"
        if first_reveal is None and now["revealed"] > 0:
            first_reveal = (presses, now["revealed"])
        last = now["revealed"]
    print("ORW816 presses", presses, "first reveal", first_reveal, now)
    assert now["roles"]["out"], f"Continue never reached the result in {presses} presses: {now}"
    assert len(now["roles"]["out"]) == 1 and now["roles"]["out"][0] in now["roles"]["nominees"], f"exactly one of the final nominees leaves: {now['roles']}"
    assert presses > 1, "the whole ceremony ran on a single press (the ballots are meant to read step by step)"
    if first_reveal:
        assert first_reveal[1] == 1, f"the first press that revealed a ballot revealed {first_reveal[1]}: the ballots read one at a time"

"""ORW-785: the voted-out PLAYER's night, through the REAL loop (real engine bundle + real FE chat route + a scripted narrator that calls NO tools, i.e. the narrator voices every goodbye in one
reply and the engine still owes its goodbye beats). Nothing is set by hand: the season is walked by the FE's own sanctioned door + real chat turns. The FE belt (`drain_player_eviction_to_card`,
bounded by EVICTED_PLAYER_DRAIN_MAX_ADVANCES) must keep advancing until the exit-interview card is up; after the player answers it, the next typed turn must reach the spectator-choice card.
Roles only. Needs the built engine bundle (skips cleanly without it)."""
from __future__ import annotations

import pytest

from test_m0_3_midgen_join import _stack  # noqa: F401  (the shared real-stack fixture)
from _a64_walk import _walk_week_one, _path, _fresh, _session, _start_day, _send, _engine

pytestmark = pytest.mark.browser

# Seasons are walked in this order (a restart on the same stack carries earlier seasons' names, which shifts later seeds); the first whose NPC HOH puts the player on the block AND evicts them is used.
SEEDS = (18, 10, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12)  # ORW-779 moved the played seasons: 18 now evicts the player (13-17 do not); ORW-410 had 10 first; the rest are the fallback


def _board(stack):
    st = _engine(stack, "getGameState")
    return (st.get("eviction") or {}).get("stage"), (st.get("pending") or {}).get("kind")


def test_a_voted_out_player_reaches_the_exit_interview_then_spectator_choice(_stack):  # noqa: F811
    sid = None
    for seed in SEEDS:
        _fresh(_stack, seed)
        sid = _session(_stack, f"orw785-{seed}")
        _start_day(_stack, sid)
        if _path(_walk_week_one(_stack, sid, want="block")) == "evicted":
            break
    else:
        pytest.fail(f"none of the seeds {SEEDS} voted the player out in week 1 - re-pick")
    # The walk's own turns already ran the belt; the card must be up while the engine is still in the eviction (not yet rolled on).
    stage, kind = _board(_stack)
    if kind != "exit-interview":  # one more typed turn is allowed to bring it (the player types on)
        _send(_stack, sid, "I type on after the goodbyes.", "orw785-typed-1")
        stage, kind = _board(_stack)
    assert (stage, kind) == ("exit-interview", "exit-interview"), f"the exit-interview card never appeared: stage={stage} pending={kind}"
    st = _engine(_stack, "getGameState")
    _engine(_stack, "submitDecision", {"kind": "exit-interview", "vote": st["pending"]["stances"][0]})
    for i in range(3):  # the player types on; the belt owes the result stage, which raises the watch-or-skip card
        _send(_stack, sid, f"Still typing {i}.", f"orw785-typed-b{i}")
        if _board(_stack)[1] == "spectator-choice":
            break
    assert _board(_stack)[1] == "spectator-choice", f"the spectator-choice card never appeared: {_board(_stack)}"

"""A64b - week 1 for the player who VOTES, plus readiness spam at the due eviction-vote card (the second half of the old test_a64_week1_clock_real_loop.py, split out by ORW-414 so each walk is its own
file; the helpers and the invariants are documented in _a64_walk.py). Real engine (dist/main.js) + real FE chat route + a scripted fake narrator that calls NO tools. Roles only."""
from __future__ import annotations

import pytest

from test_m0_3_midgen_join import _stack  # noqa: F401  (the shared real-stack fixture)
from test_p0h_day1_clock_e2e import _schedule, _send
from _a64_walk import (VOTER_SEEDS, _assert_the_eviction_landed, _assert_week_one_honours_the_clock, _decide, _walk_seeded_week)

pytestmark = pytest.mark.browser


def test_readiness_spam_at_the_due_eviction_card_does_not_double_fire(_stack):  # noqa: F811
    """A player who VOTES (the first of VOTER_SEEDS whose player keeps their vote). This is the voter path's week-1 walk, so it takes the same clock checks (1)-(3), (5), (6) first, then (4)
    at the due vote card."""
    sid, obs = _walk_seeded_week(_stack, VOTER_SEEDS, "vote", "a64-spam")
    _assert_week_one_honours_the_clock(obs)
    _assert_the_eviction_landed(obs)
    _, st = _schedule(_stack)
    card = st["pending"]
    assert card["kind"] == "eviction-vote"
    for i, line in enumerate(["I'm ready, start the eviction.", "Go ahead, call it.", "Start the vote already."]):
        _send(_stack, sid, line, f"a64-spam-{i}")
        _, st2 = _schedule(_stack)
        assert (st2.get("pending") or {}).get("kind") == "eviction-vote", f"the vote card changed after an ask: {st2.get('pending')}"
        assert st2.get("phase") == "eviction"
    # the player's own vote is what moves it, and only once
    r = _decide(_stack, st2["pending"])
    _, st3 = _schedule(_stack)
    assert (st3.get("pending") or {}).get("kind") != "eviction-vote", "the vote card must be consumed by the decision"

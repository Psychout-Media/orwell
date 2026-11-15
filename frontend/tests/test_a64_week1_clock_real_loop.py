"""A64 - week 1 played through the REAL loop under the in-game clock (0118): real engine (dist/main.js) + real FE chat route + a scripted fake narrator that calls NO tools. Extends A40 (HOH only)
across the veto competition, the veto ceremony and the eviction. These pin TODAY's behavior (invariants, not magic numbers):

 1. Each undue message costs exactly 5 minutes toward the next milestone (`daySchedule.minutesUntil`).
 2. The board never moves to a LATER phase early: a phase change is on the message that brings the previous milestone due (<= 5 minutes away before it) or after it was due. A non-card beat (an NPC HOH's
    nominations, the veto competition without the player) RUNS on that due message itself.
 3. A decision card (comp-round, eviction-vote, any card the player answers) is staged only on a message where the schedule is due - never before the due hour.
 4. Readiness spam at a due card ("I'm ready", "start it") does not progress the board, duplicate the card or double-fire it; the player's decision is what moves it.
 5. Eviction night is reached only after its own due time (evening) and the vote card is the one the engine stages there.
 6. From what the ENGINE reports (the public ceremony state: the HOH, the nominees, the veto holder, who has left the house), every week-1 result - the HOH, the nominations, the veto, the veto
    ceremony, the eviction - lands only on a step where its milestone was due, or on the message that brought it due. Never early. A player ON THE BLOCK (or the HOH) gets no eviction-vote card at
    all: their walk ends when the engine reports the evictee, and that eviction must have evicted exactly one final nominee inside the due eviction.

The week-1 PATH follows the season. The player votes in most seasons but is often on the block (5 of 14 seeds in one scan of this loop) or the HOH, and then no vote card exists for them, so an
unseeded walk that waited for one ran on into week 2 and failed at random. Each test therefore walks an ordered list of explicit seeds picked for its path (the /new-game door's `seed`) and
uses the first whose season takes it: one walk per path, both under the same clock checks.

Mismatch report (observed, not asserted): at the veto-ceremony due moment `timeOfDay` already reads "evening" while the milestone's own `phase` reads "afternoon". Roles only. Needs the built engine bundle.

ORW-414: this file is the "player on the block" walk (the helpers moved to _a64_walk.py); the voter walk + readiness spam is test_a64b_week1_voter_readiness_spam.py.
"""
from __future__ import annotations

import pytest

from test_m0_3_midgen_join import _stack  # noqa: F401  (the shared real-stack fixture)
from _a64_walk import (NOMINEE_SEEDS, _assert_the_eviction_landed, _assert_week_one_honours_the_clock, _walk_seeded_week)

pytestmark = pytest.mark.browser


def test_week_one_milestones_honour_the_clock(_stack):  # noqa: F811
    """A player ON THE BLOCK (the first of NOMINEE_SEEDS whose NPC HOH nominates them): no eviction-vote card is theirs, so the week is read from what the engine reports. The voter's path
    gets the same clock checks in the readiness-spam test below (one walk per path)."""
    _, obs = _walk_seeded_week(_stack, NOMINEE_SEEDS, "block", "a64-week1")
    _assert_week_one_honours_the_clock(obs)
    _assert_the_eviction_landed(obs)

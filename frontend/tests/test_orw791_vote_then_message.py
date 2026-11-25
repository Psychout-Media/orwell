"""ORW-791: the eviction night for the player who VOTES. Real engine (dist/main.js) + real FE chat route + a scripted fake narrator that calls NO tools, a seeded season whose player keeps their vote
(the same walk as test_a64b). No state is set by hand.

After the player's own vote card the engine has read the first ballot. Two things must hold:
 1. the player gets the same Continue step as everyone else (a watch step, one press = one engine step, never more), not a bare board with nothing to press;
 2. a typed message is ONE message-step (ORW-703): it never drives the remaining ballots (or the result) in one turn.
Roles only."""
from __future__ import annotations

import pytest

from test_m0_3_midgen_join import _stack  # noqa: F401  (the shared real-stack fixture)
from test_p0h_day1_clock_e2e import _engine, _schedule, _send
from _a64_walk import VOTER_SEEDS, _decide, _walk_seeded_week

pytestmark = pytest.mark.browser


def _read(stack):
    _, st = _schedule(stack)
    ev = st.get("eviction") or {}
    return {"pending": st.get("pending") or None, "revealed": len(ev.get("votesRevealed") or []), "stage": ev.get("stage"),
            "out": sorted(h.get("id") for h in st.get("house") or [] if h.get("status") not in (None, "active")), "seq": st.get("beatSeq")}


def _voter_after_own_vote(stack):
    sid, obs = _walk_seeded_week(stack, VOTER_SEEDS, "vote", "orw791")
    _, st = _schedule(stack)
    assert (st.get("pending") or {}).get("kind") == "eviction-vote", f"the walk did not end on the player's vote card: {st.get('pending')}"
    _decide(stack, st["pending"])
    return sid


def test_after_the_players_own_vote_a_continue_press_is_one_step(_stack):  # noqa: F811
    sid = _voter_after_own_vote(_stack)
    after_vote = _read(_stack)
    print("ORW791 after-vote", after_vote)
    assert after_vote["revealed"] == 1, f"the player's own vote reads exactly the first ballot: {after_vote}"
    pend = after_vote["pending"] or {}
    assert pend.get("kind") == "ceremony-step", f"the player who voted gets the same Continue step as everyone: {after_vote}"
    assert (pend.get("ceremony") or {}).get("stepId") == "ballot"
    adv = _engine(_stack, "advanceGame", {})  # exactly the Continue button's call
    after_press = _read(_stack)
    print("ORW791 after-press", after_press)
    assert after_press["revealed"] == 2 and not after_press["out"], f"one press reads one ballot and names no evictee: {after_press} {str(adv)[:200]}"


def test_one_typed_message_after_the_vote_is_one_message_step(_stack):  # noqa: F811
    sid = _voter_after_own_vote(_stack)
    before = _read(_stack)
    _send(_stack, sid, "That was a hard one to cast.", "orw791-m1")
    after = _read(_stack)
    print("ORW791 msg", before, after)
    assert not after["out"], f"one typed message must not run the vote to its result: {before} -> {after}"
    assert after["revealed"] - before["revealed"] <= 1, f"one typed message drives at most one engine step, not the remaining ballots: {before} -> {after}"
    assert (after["pending"] or {}).get("kind") == "ceremony-step", f"the Continue step is still the player's to press: {after}"

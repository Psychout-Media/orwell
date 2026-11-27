"""ORW-846: a bare "next" typed at an eviction BALLOT step reads exactly ONE ballot (the Continue press's step), and only an explicit fast-forward walks the rest. Real engine (dist/main.js) +
real FE chat route + a scripted fake narrator that calls NO tools, the seeded season whose player keeps their vote (the same walk as test_orw791_vote_then_message). No state is set by hand.

Guarded: the engine only leaves a ceremony-step ballot pending for a player who voted once ORW-791 is on main; until then the test skips (it asserts nothing about a board it never reached).
Roles only; the sealed ballots stay sealed (the test reads revealed COUNTS, never a voter)."""
from __future__ import annotations

import pytest

from test_m0_3_midgen_join import _stack  # noqa: F401  (the shared real-stack fixture)
from test_p0h_day1_clock_e2e import _schedule, _send
from _a64_walk import VOTER_SEEDS, _decide, _walk_seeded_week

pytestmark = pytest.mark.browser


def _read(stack):
    _, st = _schedule(stack)
    ev = st.get("eviction") or {}
    return {"pending": st.get("pending") or None, "revealed": len(ev.get("votesRevealed") or []),
            "out": sorted(h.get("id") for h in st.get("house") or [] if h.get("status") not in (None, "active"))}


def _at_ballot_step_after_own_vote(stack):
    sid, _obs = _walk_seeded_week(stack, VOTER_SEEDS, "vote", "orw846")
    _, st = _schedule(stack)
    assert (st.get("pending") or {}).get("kind") == "eviction-vote", f"the walk did not end on the player's vote card: {st.get('pending')}"
    _decide(stack, st["pending"])
    now = _read(stack)
    if (now["pending"] or {}).get("kind") != "ceremony-step":
        pytest.skip("the engine does not yet leave the voted player a ballot step (ORW-791 not on this base)")
    return sid


def test_bare_next_reads_exactly_one_ballot(_stack):  # noqa: F811
    sid = _at_ballot_step_after_own_vote(_stack)
    before = _read(_stack)
    _send(_stack, sid, "next", "orw846-m1")
    after = _read(_stack)
    print("ORW846 next", before, after)
    assert after["revealed"] - before["revealed"] == 1 and not after["out"], f"a bare next reads one ballot: {before} -> {after}"


def test_explicit_fast_forward_walks_the_remaining_ballots(_stack):  # noqa: F811
    sid = _at_ballot_step_after_own_vote(_stack)
    before = _read(_stack)
    _send(_stack, sid, "skip to the result", "orw846-m2")
    after = _read(_stack)
    print("ORW846 ff", before, after)
    assert after["revealed"] - before["revealed"] > 1, f"an explicit fast-forward walks the remaining ballots: {before} -> {after}"


def test_typed_talk_advances_nothing(_stack):  # noqa: F811
    sid = _at_ballot_step_after_own_vote(_stack)
    before = _read(_stack)
    _send(_stack, sid, "That was a hard one to cast.", "orw846-m3")
    after = _read(_stack)
    assert after["revealed"] - before["revealed"] <= 0 and not after["out"], f"talk reads no ballot: {before} -> {after}"

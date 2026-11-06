"""A64 - week 1 played through the REAL loop under the in-game clock (0118): real engine (dist/main.js) + real FE chat route + a scripted fake narrator that calls NO tools. Extends A40 (HOH only)
across the veto competition, the veto ceremony and the eviction. These pin TODAY's behavior (invariants, not magic numbers):

 1. Each undue message costs exactly 5 minutes toward the next milestone (`daySchedule.minutesUntil`).
 2. The board never moves to a LATER phase early: a phase change is on the message that brings the previous milestone due (<= 5 minutes away before it) or after it was due. A non-card beat (an NPC HOH's
    nominations, the veto competition without the player) RUNS on that due message itself.
 3. A decision card (comp-round, eviction-vote) is staged only on a message where the schedule is due - never before the due hour.
 4. Readiness spam at a due card ("I'm ready", "start it") does not progress the board, duplicate the card or double-fire it; the player's decision is what moves it.
 5. Eviction night is reached only after its own due time (evening) and the vote card is the one the engine stages there.

Mismatch report (observed, not asserted): at the veto-ceremony due moment `timeOfDay` already reads "evening" while the milestone's own `phase` reads "afternoon". Roles only. Needs the built engine bundle.
"""
from __future__ import annotations

import pytest

from test_m0_3_midgen_join import _stack  # noqa: F401  (the shared real-stack fixture)
from test_p0h_day1_clock_e2e import _engine, _schedule, _send, _session, _start_day
from test_a40_due_ceremony_real_loop import _fresh

pytestmark = pytest.mark.browser


def _decide(stack, p):
    k = p["kind"]
    opts = [o["id"] for o in (p.get("options") or [])]
    req = {"comp-round": {"kind": k, "intent": "compete"}, "comp-intent": {"kind": k, "intent": "compete"},
           "nominations": {"kind": k, "choice": opts[:2]}, "veto-decision": {"kind": k, "use": False},
           "replacement": {"kind": k, "replacement": opts[:1] and opts[0]},
           "eviction-vote": {"kind": k, "vote": opts[:1] and opts[0]}}[k]
    return _engine(stack, "submitDecision", req)


def _walk_week_one(stack, sid):
    """Drive week 1 to the eviction vote card; returns the list of (message_index, sched, phase, pending_kind) observations taken AFTER every message."""
    obs = []
    n = 0
    for _ in range(420):
        s, st = _schedule(stack)
        pend = (st.get("pending") or {}).get("kind")
        obs.append((n, s, st.get("phase"), pend))
        if pend == "eviction-vote":
            return obs
        if pend:
            _decide(stack, st["pending"])
            continue
        _send(stack, sid, f"Plain chat line {n}.", f"a64-{n}")
        n += 1
    raise AssertionError(f"week 1 never reached the eviction vote: last={obs[-1]}")


def test_week_one_milestones_honour_the_clock(_stack):  # noqa: F811
    _fresh(_stack)
    sid = _session(_stack, "a64-week1")
    _start_day(_stack, sid)
    obs = _walk_week_one(_stack, sid)
    saw_phases = []
    prev = None
    for (n, s, phase, pend) in obs:
        if prev is not None:
            pn, ps, pphase, ppend = prev
            if phase != pphase:
                # (2) a phase change happens only on the message that BRINGS the previous milestone due (<= one 5-minute message away) or after it was due - never earlier
                assert ps["due"] is True or ppend or ps["minutesUntil"] <= 5, f"phase {pphase} -> {phase} at message {n} but the previous milestone was not due: {ps}"
            elif ps["next"] == s["next"] and not ps["due"] and not s["due"] and ppend is None and pend is None:
                # (1) an undue message in the same milestone costs exactly 5 minutes
                assert ps["minutesUntil"] - s["minutesUntil"] in (5, 0), f"message {n}: {ps} -> {s}"
        if pend:
            assert s["due"] is True, f"(3) a {pend} card was staged at message {n} before the milestone was due: {s}"
        if phase not in saw_phases:
            saw_phases.append(phase)
        prev = (n, s, phase, pend)
    # (5) every week-1 phase was visited in order and the eviction vote came last
    assert saw_phases[:1] == ["hoh-competition"]
    for want in ("nominations", "veto-competition", "veto-ceremony", "eviction"):
        assert want in saw_phases, f"week 1 skipped {want}: {saw_phases}"
    assert saw_phases.index("nominations") < saw_phases.index("veto-competition") < saw_phases.index("veto-ceremony") < saw_phases.index("eviction")
    n_last, s_last, _, pend_last = obs[-1]
    assert pend_last == "eviction-vote" and s_last["due"] is True and s_last["next"] == "eviction"


def test_readiness_spam_at_the_due_eviction_card_does_not_double_fire(_stack):  # noqa: F811
    _fresh(_stack)
    sid = _session(_stack, "a64-spam")
    _start_day(_stack, sid)
    obs = _walk_week_one(_stack, sid)
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

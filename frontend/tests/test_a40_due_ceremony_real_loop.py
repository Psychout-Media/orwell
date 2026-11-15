"""A40 - what a DUE ceremony does under the in-game clock (0118), pinned through the REAL loop: real engine (dist/main.js) + real FE chat route + a scripted fake narrator that calls NO tools,
so the only engine effects are the FE's own (the per-message clock announcement and its progression belts). These pin TODAY's behavior:

 1. EARLY asks: a player asking for the competition at 8:00 (and again, and again) never starts it; each ask is an ordinary 5-minute message; no card, no HOH.
 2. DUE mid-chat: the competition card appears on exactly the message that makes it due (the 48th), not the 47th.
 3. AFTER readiness: once due and staged, more "I'm ready" / "start it" messages do not progress the board, do not duplicate the card and do not crown anyone; the player's approach is what moves it.

4. The MODEL-DRIVEN path: a fake narrator that DOES call advanceGame when the player asks early is held by the FE (`scheduled_event_is_held`, mutation-checked: dropping it stages the card).

Design note for the Coordinator (see the write-up): the ENGINE's advanceGame is not gated by the schedule (an explicit advance stages the competition at any hour); the production-schedule rule
("production owns the schedule") is enforced by the FE belts + the clock, which is what these tests pin. Roles only. Needs the built engine bundle (skips cleanly without it).
"""
from __future__ import annotations

import pytest

from test_m0_3_midgen_join import STUB, _post_form, _post_json, _stack  # noqa: F401  (the shared real-stack fixture)
from test_p0h_day1_clock_e2e import _engine, _schedule, _send, _session, _start_day

pytestmark = pytest.mark.browser

EARLY = [
    "Let's start the Head of Household competition right now.",
    "Ok, can we start the competition now? I'm ready.",
    "Production, call the competition, everyone is here.",
    "Start the competition.",
]


def _fresh(stack, seed=None):
    """A fresh season through the FE's own sanctioned restart door (the stack is shared by the real-stack pins). `seed` pins the season (the door's optional `seed`; explicit seeds are
    first-class for tests and replays); None = real entropy, a different game every run (as in play)."""
    body = {"playerName": "P", "confirm": True}
    if seed is not None:
        body["seed"] = seed
    r = _post_json(stack["fe"], "/api/orwell/new-game", body, timeout=120)
    assert r.get("started"), r


def _board(stack):
    sched, st = _schedule(stack)
    return sched, (st.get("pending") or {}).get("kind"), (st.get("ceremony") or {}).get("hoh"), st.get("phase")


def test_early_asks_never_start_the_competition_and_each_costs_five_minutes(_stack):  # noqa: F811
    _fresh(_stack)
    sid = _session(_stack, "a40-early")
    sched0, _ = _start_day(_stack, sid)
    assert sched0["minutesUntil"] == 240 and sched0["due"] is False
    prev = 240
    for i, line in enumerate(EARLY):
        _send(_stack, sid, line, f"a40-early-{i}")
        sched, pending, hoh, phase = _board(_stack)
        assert sched["due"] is False, f"not due at {sched}"
        assert pending is None, f"an early ask staged a decision card ({pending}) - production owns the schedule"
        assert hoh is None, "no HOH may be crowned before the competition is called"
        assert phase in ("premiere", "hoh-competition")  # ORW-116: the premiere exit is taken when the HOH comes due
        assert prev - sched["minutesUntil"] == 5, f"an early ask is an ordinary 5-minute message: {prev} -> {sched}"
        prev = sched["minutesUntil"]


def test_the_competition_card_appears_on_exactly_the_message_that_makes_it_due(_stack):  # noqa: F811
    _fresh(_stack)
    sid = _session(_stack, "a40-due")
    _start_day(_stack, sid)
    for i in range(1, 49):
        _send(_stack, sid, f"Plain chat line {i}.", f"a40-due-{i}")
        sched, pending, hoh, _ = _board(_stack)
        if i < 48:
            assert sched["due"] is False and pending is None, f"message {i}: nothing is due or staged yet: {sched} {pending}"
        else:
            assert sched["due"] is True, f"the 48th message reaches noon: {sched}"
            assert pending is not None and pending.startswith("comp-"), f"the competition card is staged on the message that makes it due, got {pending!r}"
        assert hoh is None


def test_after_readiness_more_asks_do_not_progress_duplicate_or_crown(_stack):  # noqa: F811
    _fresh(_stack)
    sid = _session(_stack, "a40-ready")
    _start_day(_stack, sid)
    for i in range(1, 49):
        _send(_stack, sid, f"Plain chat line {i}.", f"a40-ready-{i}")
    s0, pending0, hoh0, phase0 = _board(_stack)
    assert s0["due"] is True and pending0 and pending0.startswith("comp-")
    seq0 = _engine(_stack, "getGameState").get("beatSeq")
    for i, line in enumerate(["I'm ready for the competition.", "Let's go, start the competition.", "Come on, start it already."]):
        _send(_stack, sid, line, f"a40-ready-ask-{i}")
        s, pending, hoh, phase = _board(_stack)
        assert pending == pending0, f"the staged card must stay the SAME one (no duplicate, no skip): {pending0} -> {pending}"
        assert hoh is None and phase == phase0, f"asking is not playing: nobody is crowned and the phase holds ({phase0} -> {phase}, hoh={hoh})"
    # the player's APPROACH (the card), not their words, is what moves it
    st = _engine(_stack, "getGameState")
    assert (st.get("pending") or {}).get("kind") == pending0
    assert st.get("beatSeq") is not None and seq0 is not None


def test_a_narrator_that_calls_advance_early_does_not_start_the_competition(_stack):  # noqa: F811
    """The model-driven path: the player asks early and the fake narrator DOES call advanceGame (a real model often will). The FE's production hold must not let the competition start before it is due."""
    _fresh(_stack)
    sid = _session(_stack, "a40-adv")
    _start_day(_stack, sid)
    before, pending_before, _, _ = _board(_stack)
    STUB.script.append({"tool_calls": [{"name": "advanceGame", "args": {}}]})
    STUB.script.append({"deltas": ["Alright, the house heads out to the backyard."], "delay": 0})
    body = _send(_stack, sid, "Let's start the Head of Household competition right now.", "a40-adv-1")
    assert "advanceGame" in body and not STUB.script, "the scripted advanceGame call must actually have been made (otherwise this proves nothing)"
    after, pending, hoh, phase = _board(_stack)
    assert after["due"] is False
    assert pending is None, f"a model-called advanceGame at 8am staged a card ({pending}) - production owns the schedule"
    assert hoh is None and phase in ("premiere", "hoh-competition")

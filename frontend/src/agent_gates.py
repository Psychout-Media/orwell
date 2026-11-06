"""A60 (#1814 R3) - the agent loop's nudge GATES as pure functions.

These five booleans decide whether the FE error-corrects a model that skipped a call (advance the game / record the scene / move the player / move an NPC / voice an approach). They used to be inline expressions
inside the ~3000-line `agent_loop` generator over ~15 local variables, so nothing could call them. Each function body below is the ORIGINAL EXPRESSION, VERBATIM, over the same locals passed as arguments:
this is a mechanical, behavior-neutral extraction, pinned by the table-driven harness in tests/test_a60_gating_lattice.py (which compares every permutation against a frozen copy of the original expressions and has
flip-one-gate mutants). No behavior lives here that is not in the original; do not "improve" a gate in this file without changing that test on purpose."""
from __future__ import annotations

from typing import Callable


def want_advance(*, turn_advance_nudges: int, max_advance_nudges: int, previewed_uncommitted: bool, decision_undelivered: bool, want_drain_eviction: bool,
                 milestone_due: bool, progressed: bool, runway_holding: bool, loop_stalled: bool, is_lull: bool, stale: bool) -> bool:
    return (turn_advance_nudges < max_advance_nudges and (
        previewed_uncommitted
        or decision_undelivered
        or want_drain_eviction
        or (milestone_due and (not progressed) and not runway_holding)
        or (loop_stalled and not runway_holding)
        or ((not progressed) and is_lull and stale and not runway_holding)))


def want_record(*, recorded: bool, is_lull: bool, lull_message_carries_talk: Callable[[], bool], turn_record_nudges: int, max_record_nudges: int) -> bool:
    # `lull_message_carries_talk` is a thunk so the short-circuit of the original (`(not is_lull) or carries_talk(messages)`) is preserved exactly.
    return ((not recorded) and ((not is_lull) or lull_message_carries_talk())
            and turn_record_nudges < max_record_nudges)


def want_move(*, moved: bool, turn_move_nudges: int, max_move_nudges: int, signal_in_user_message: bool, signal_in_narration: bool) -> bool:
    return ((not moved)
            and turn_move_nudges < max_move_nudges
            and bool(signal_in_user_message or signal_in_narration))


def want_npc_move(*, npc_moved: bool, turn_npc_move_nudges: int, max_npc_move_nudges: int, signal_in_narration: bool) -> bool:
    return ((not npc_moved)
            and turn_npc_move_nudges < max_npc_move_nudges
            and bool(signal_in_narration))


def want_approach(*, is_lull: bool, progressed: bool, stale: bool, emitted_visible: bool, turn_approach_nudges: int, max_approach_nudges: int) -> bool:
    return (is_lull and (not progressed) and (not stale)
            and (not emitted_visible)
            and turn_approach_nudges < max_approach_nudges)


def want_drain_eviction(*, in_eviction: bool, progressed: bool, turn_advance_nudges: int, max_advance_nudges: int, production_holding: bool) -> bool:
    """F14 (#1013) eviction-drain allowance, now gated by the PRODUCTION HOLD (ORW fix): while production holds the eviction (it is scheduled for the evening and not yet due) the
    drain must NOT force the ceremony open early. Before #2250 the false "peer-advance" on every held turn masked this (it suppressed the whole advance block); with that fixed, the drain
    was the one force path with no hold check and raised the player's eviction-vote card hours early. When the hold pops (the event is due) the drain works exactly as before."""
    return bool(in_eviction and (not progressed) and turn_advance_nudges < max_advance_nudges and not production_holding)


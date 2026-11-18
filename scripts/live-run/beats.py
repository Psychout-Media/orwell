#!/usr/bin/env python3
"""ORW-109: the veto-ceremony and finale beats of the formal short tier (`live_short.py --veto-ceremony` / `--finale`; `--eviction` is eviction_e1.py).

Each beat JUMPS the engine to its phase with the engine's own closed-set player API (the simplest legal answers, stopping AT the phase and never past it, no model
call), then plays a few real chat turns on the real narrator under the run's budget. Nothing here starts a service or spends on its own. Roles only.
The pure helpers are unit-tested offline in frontend/tests/test_live_compare.py.
"""
from __future__ import annotations

VETO_LINES = [
    "I wait for the Veto Ceremony. Let's do it now.",
    "I watch the veto holder and listen to what they decide.",
    "I look around the room to see who is nervous.",
    "I stay close and wait for the veto holder to announce it.",
]
FINALE_LINES = [
    "I take a breath and listen to the finalists' statements.",
    "I listen to the jurors' questions.",
    "I watch the votes being read.",
    "I wait for the winner to be announced.",
]
MAX_BEAT_TURNS = 6


def bounded(n, default=4, ceiling=MAX_BEAT_TURNS):
    try:
        n = int(n)
    except (TypeError, ValueError):
        return default
    return max(1, min(ceiling, n))


def beat_lines(lines, n):
    return [lines[min(i, len(lines) - 1)] for i in range(bounded(n))]


def veto_ceremony_fired(state, phase_at_start="veto-ceremony"):
    """True once the engine committed the ceremony: the phase moved on from the veto ceremony."""
    return (state or {}).get("phase") != phase_at_start


def finale_over(state):
    s = state or {}
    return bool(s.get("finished")) or bool(s.get("winner")) or s.get("phase") == "complete"


def run_veto_ceremony(eng, play, check, chat, turns=4):
    """Jump to the veto ceremony and play it through the real chat. V1 reached, V2 the ceremony fires inside the stall window (the ORW-10 shape: the ceremony is due and the
    narration never commits it)."""
    from eviction_e1 import advance_to_due
    from live_week import CARD, Week
    eng.play_pendings_until("veto-ceremony", "v1", max_steps=80)
    st = eng.call("getGameState")
    reached = st.get("phase") == "veto-ceremony"
    check("V1-reached-veto-ceremony", reached, f"phase {st.get('phase')} week {st.get('week')} (forced entry: the engine's closed set, stopped at the veto ceremony)")
    if not reached:
        return
    check("V1b-clock-near-the-ceremony", advance_to_due(eng), f"daySchedule {(st.get('daySchedule') or {}).get('minutesUntil')} minutes until due (moved by engine ticks)", "warn")
    week = Week(chat.page, chat.base)
    week.name_fn = lambda: ((eng.call("getGameState") or {}).get("player") or {}).get("name")
    fired, played = False, 0
    for line in beat_lines(VETO_LINES, turns):
        if chat.page.evaluate(CARD):
            week.card_turn()
        play(f"veto-ceremony-{played + 1}", line); played += 1
        if veto_ceremony_fired(eng.call("getGameState")):
            fired = True
            break
    check("V2-veto-ceremony-fires", fired, f"{played} chat turn(s) with the ceremony due; fired={fired} (the stall rule allows 3 turns, 1 after an explicit ask)")


def run_finale(eng, play, check, chat, turns=4):
    """Jump to the finale and play it through the real chat. F1 reached, F2 the finale is over or still honestly in progress (never a phantom winner: B5 reads each turn)."""
    from live_week import CARD, Week
    eng.play_pendings_until("finale", "f1", max_steps=400)
    st = eng.call("getGameState")
    reached = st.get("phase") in ("finale", "complete") or finale_over(st)
    check("F1-reached-finale", reached, f"phase {st.get('phase')} week {st.get('week')} (forced entry: the engine's closed set, stopped at the finale)")
    if not reached:
        return
    week = Week(chat.page, chat.base)
    week.name_fn = lambda: ((eng.call("getGameState") or {}).get("player") or {}).get("name")
    played = 0
    for line in beat_lines(FINALE_LINES, turns):
        if chat.page.evaluate(CARD):
            week.card_turn()
        play(f"finale-{played + 1}", line); played += 1
        if finale_over(eng.call("getGameState")):
            break
    st = eng.call("getGameState")
    check("F2-finale-engine-consistent", bool(st.get("phase")), f"phase {st.get('phase')} finished={st.get('finished')} after {played} chat turn(s); a winner named in narration before the engine recorded one fails B5", "note")

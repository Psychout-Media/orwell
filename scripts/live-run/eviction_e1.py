#!/usr/bin/env python3
"""ORW-506: the FORCED-EVICTION E-1 entry point of the short tier (`live_short.py --eviction`).

The short tier stops at the Week 1 veto morning, and `--crossover` drives the engine THROUGH eviction night without playing it. This module reaches eviction night
reliably (the engine's own closed set answered with the simplest legal picks, stopping AT the eviction phase and never past it) and then plays the night through the
REAL chat: real player messages, with any decision card the front end shows (the player's vote, a watch step) answered in the UI before the next message is typed.

Nothing here starts a service or spends on its own: it runs inside a live_short run, under that run's spend guard (RIG_SPEND_CAP, run_short.sh) and a hard turn bound.
The pure helpers (`night_resolved`, `evicted_names`, `bounded_turns`, `next_line`) are unit-tested offline in test_eviction_e1.py. Roles only; no cast name is hard-coded.
"""
from __future__ import annotations

import time

MAX_TURNS_CEILING = 20          # a hard ceiling on the real-chat turns of the night, whatever the flag says
DEFAULT_TURNS = 8
EVICTION_LINES = [
    "I stay quiet and watch the ballots being read.",
    "I listen to what the evicted houseguest says on the way out.",
    "I say a short, warm goodbye to the houseguest who is leaving.",
    "I look around the room to see who looks rattled.",
    "I check in with whoever is sitting closest to me about the vote.",
]


def bounded_turns(n):
    """The requested real-chat turn count, clamped to 1..MAX_TURNS_CEILING (a bad value falls back to the default, never to unbounded)."""
    try:
        n = int(n)
    except (TypeError, ValueError):
        return DEFAULT_TURNS
    return max(1, min(MAX_TURNS_CEILING, n))


def next_line(i):
    """The i-th (0-based) eviction-night player message; cycles, so any bounded count has a line."""
    return EVICTION_LINES[i % len(EVICTION_LINES)]


def evicted_names(recap):
    """The names the engine's seasonRecap lists as evicted, in order (empty for anything unexpected)."""
    out = []
    items = (recap.get("evicted") if isinstance(recap, dict) else None) or []
    for x in items:
        n = x.get("name") if isinstance(x, dict) else x
        if n:
            out.append(str(n))
    return out


def night_resolved(state, evicted_before, week_before, evicted_now):
    """True once the night has played out ENGINE-side: one more houseguest is recorded as evicted, or the week has moved on. Roles only; read from engine truth, never from prose."""
    if len(evicted_now) > len(evicted_before):
        return True
    wk = (state or {}).get("week")
    return isinstance(wk, int) and isinstance(week_before, int) and wk > week_before


NEAR_DUE_MINUTES = 30
MAX_ADVANCE_TICKS = 500


def advance_to_due(eng, minutes_before=NEAR_DUE_MINUTES, max_ticks=MAX_ADVANCE_TICKS):
    """Move the engine's clock until the next ceremony is `minutes_before` or fewer minutes away AND the night before it has passed (ORW-258: the eviction waits behind the night; `daySchedule.tomorrow` is cleared).
    The clock moves in BIG steps: `hangOut` (a bounded run of 15-30 minute beats, up to ~3 hours per call, clamped at the due event, no model call); a refusal or a call that does not move the clock falls back to one message tick
    (`noteMessage`, 5 minutes and a save each: a live run that used ticks alone spent over an hour of save latency); bed at the night. True once the clock is that close (or the event is due); False if the bound ran out."""
    def minutes(ds):
        v = ds.get("minutesUntil")
        return v if isinstance(v, (int, float)) else None
    for n in range(max_ticks):
        ds = (eng.call("getGameState") or {}).get("daySchedule") or {}
        mu = minutes(ds)
        # the eviction waits BEHIND the night (ORW-258): it only counts as night-of-eviction once the night has passed (`tomorrow` cleared), however few minutes the schedule reads
        if not ds.get("tomorrow") and (ds.get("due") or (mu is not None and mu <= minutes_before)):
            return True
        h, _ = eng.hour()
        if h is not None and h >= 24:
            eng.sleep_through_night(f"e1s{n}")
            continue
        moved = False
        try:
            r = eng.call("hangOut", {"maxMinutes": 180}) or {}
            after = minutes((eng.call("getGameState") or {}).get("daySchedule") or {})
            moved = mu is not None and after is not None and after < mu and not (isinstance(r, dict) and r.get("refused"))
        except RuntimeError:
            moved = False
        if not moved:
            eng.call("noteMessage", {"messageId": f"e1-adv-{n}"})
    return False


def run(eng, play, check, chat, turns=DEFAULT_TURNS):
    """Drive to eviction night and play it through the real chat. `eng` is live_short.Engine, `play(label, text)` records one chat turn, `check` records a result."""
    from live_week import CARD, Week   # lazy: live_week imports live_short, which imports this module's caller
    turns = bounded_turns(turns)
    eng.play_pendings_until("eviction", "e1", max_steps=80)
    st = eng.call("getGameState")
    reached = st.get("phase") == "eviction"
    check("E1-reached-eviction-night", reached, f"phase {st.get('phase')} week {st.get('week')} at {st.get('clockLabel')} (forced entry: the engine's closed set, stopped at the eviction phase)")
    if not reached:
        return
    # The engine's eviction ceremony is DUE on a later clock (live runs 2 and 3: the phase was "eviction" but `daySchedule.minutesUntil` read ~1290, so 16 chat turns at 5 minutes each could never reach it): move the
    # clock with the engine's own message ticks (no model cost; the same harness jump the crossover tier uses) to ~30 minutes before the ceremony is due, then play the rest through the real chat.
    near = advance_to_due(eng)
    st = eng.call("getGameState")
    check("E1b-clock-near-the-ceremony", near, f"daySchedule {(st.get('daySchedule') or {}).get('minutesUntil')} minutes until due at {st.get('clockLabel')} (moved with {NEAR_DUE_MINUTES} minutes to spare, by engine ticks)")
    before = evicted_names(eng.call("seasonRecap")); wk0 = st.get("week")
    week = Week(chat.page, chat.base)
    week.name_fn = lambda: ((eng.call("getGameState") or {}).get("player") or {}).get("name")
    played = cards = 0; resolved = False
    # a card turn costs a model call too (the narrator voices the answer), so cards count against the same bound: at most 2x the chat turns in total
    for _ in range(turns * 2):
        st = eng.call("getGameState"); now = evicted_names(eng.call("seasonRecap"))
        if night_resolved(st, before, wk0, now):
            resolved = True
            break
        c = chat.page.evaluate(CARD)
        if c:
            r = week.card_turn(); cards += 1   # live_week's own card answer + wait (the bubble count is the page's BUB list, never a bare number)
            check(f"E3-card-answered[{cards}]", True, str((r or {}).get("label_extra", "card")), "note")
            continue
        if played >= turns:
            break
        play(f"eviction-{played + 1}", next_line(played)); played += 1
    st = eng.call("getGameState"); now = evicted_names(eng.call("seasonRecap"))
    resolved = resolved or night_resolved(st, before, wk0, now)
    check("E2-eviction-resolved", resolved, f"evicted before {len(before)}, after {len(now)}; week {wk0} -> {st.get('week')}; {played} chat turns and {cards} cards (bound {turns} turns)")
    stuck = chat.page.evaluate(CARD) is not None or bool(st.get("pending"))
    check("E3-no-stuck-card", not stuck, "no decision card on screen and nothing pending at the end of the night" if not stuck else f"a card or pending is still open (pending {((st.get('pending') or {}) or {}).get('kind') if isinstance(st.get('pending'), dict) else st.get('pending')!r})")

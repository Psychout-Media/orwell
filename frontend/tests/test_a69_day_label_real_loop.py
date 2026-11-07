"""A69 - the day number in the clock label follows the schedule's roll, through the REAL loop (real engine bundle + real FE chat route + a no-tool fake narrator): the label never goes backwards and the Day rises
when the schedule rolls to the next milestone's morning (it stayed "Day 1" at four different 8:00ams before). Roles only. Needs the built engine bundle (skips cleanly without)."""
from __future__ import annotations

import re

import pytest

from test_m0_3_midgen_join import _post_json, _stack  # noqa: F401  (the shared real-stack fixture)
from test_p0h_day1_clock_e2e import _engine, _schedule, _send, _session, _start_day

pytestmark = pytest.mark.browser


def _label(stack):
    _, st = _schedule(stack)
    m = re.match(r"^(\d{1,2}):(\d{2})(am|pm), Day (\d+)$", st.get("clockLabel") or "")
    assert m, f"clockLabel must be 'H:MMam, Day N' while the clock runs, got {st.get('clockLabel')!r}"
    h = int(m.group(1)) % 12 + (12 if m.group(3) == "pm" else 0)
    return int(m.group(4)), h * 60 + int(m.group(2)), st


def test_the_label_day_rises_when_the_schedule_rolls_and_never_goes_backwards(_stack):  # noqa: F811
    r = _post_json(_stack["fe"], "/api/orwell/new-game", {"playerName": "P", "confirm": True}, timeout=120)  # the sanctioned restart door
    assert r.get("started"), r
    sid = _session(_stack, "a69-days")
    _start_day(_stack, sid)
    day0, _, _ = _label(_stack)
    assert day0 == 2  # ORW-116: _start_day now plays the premiere night and starts Day 2 at 8am
    last_day, last_min, rolled = day0, None, 0
    for i in range(1, 320):
        _, st = _schedule(_stack)
        if st.get("timeOfDay") in ("evening", "night", "late-night") and not (st.get("pending") or {}).get("kind"):
            _engine(_stack, "turnIn")  # ORW-116: the night is the player's - a player who goes to bed is what rolls the day (nothing else does)
        p = st.get("pending") or {}
        if p.get("kind") in ("comp-round", "comp-intent"):
            _engine(_stack, "submitDecision", {"kind": p["kind"], "intent": "compete"})
        elif p.get("kind"):
            opts = [o["id"] for o in (p.get("options") or [])]
            _engine(_stack, "submitDecision", {"kind": p["kind"], **({"choice": opts[:2]} if p["kind"] == "nominations" else {"use": False} if p["kind"] == "veto-decision" else {"vote": opts[0]} if opts else {})})
        _send(_stack, sid, f"Plain chat line {i}.", f"a69-{i}")
        day, minute, _ = _label(_stack)
        assert day >= last_day, f"the day fell: {last_day} -> {day}"
        if last_min is not None and minute < last_min - 60:  # the clock rolled to a fresh morning
            rolled += 1
            assert day == last_day + 1, f"a roll to a new morning must be a new day: {last_day} -> {day} (clock {last_min} -> {minute} min)"
        last_day, last_min = day, minute
        if rolled >= 2:
            break
    assert rolled >= 2, f"the schedule should have rolled twice in {i} messages (got {rolled})"

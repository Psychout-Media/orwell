"""ORW-740b: the room the narrator is handed for a competition or ceremony is the room the engine seats the house (and the player) in, through the REAL loop: real engine (dist/main.js) + real FE
chat route + a scripted stub narrator that calls NO tools; week 1 is walked with the shared A64 driver. Nothing is set by hand: the clock moves by real player messages, the events fire when due.

 1. A real "go to X" message (the FE's own move resolver) puts the player where they said, and the closed /whereabouts route the browser reads agrees (room + this season's room name).
 2. At every due event the engine's briefing (`daySchedule.stagingRoom`) names the room its own advance then seats the player in (competitions in the backyard, ceremonies in the living room), and while
    the event is in session the whereabouts `houseEvent.room` is that same room.
Roles only. Needs the built engine bundle (`npm run build`).
"""
from __future__ import annotations

import json
import urllib.request

import pytest

from test_m0_3_midgen_join import _stack  # noqa: F401  (the shared real-stack fixture)
from test_p0h_day1_clock_e2e import _engine, _schedule, _send, _session, _start_day
from test_a40_due_ceremony_real_loop import _fresh
from _a64_walk import VOTER_SEEDS, _decide

pytestmark = pytest.mark.browser

_STAGING = {"hoh-competition": "backyard", "veto-competition": "backyard", "nominations": "living-room", "veto-draw": "living-room", "veto-ceremony": "living-room", "eviction": "living-room"}


def _fe_whereabouts(stack):
    with urllib.request.urlopen(stack["fe"] + "/api/orwell/whereabouts", timeout=30) as r:
        return (json.loads(r.read()) or {}).get("whereabouts") or {}


def test_go_to_a_room_and_the_event_rooms_agree_through_the_real_loop(_stack):  # noqa: F811
    _fresh(_stack, VOTER_SEEDS[0])
    sid = _session(_stack, "orw740b-room")
    _start_day(_stack, sid)
    # (1) a real "go to X" through the chat route: the FE resolves the player's own move, the engine seats them, the browser's closed route reads the same room
    _send(_stack, sid, "I go to the kitchen.", "orw740b-go")
    wa = _fe_whereabouts(_stack)
    assert wa.get("room") == "kitchen", f"the player said they went to the kitchen: {wa}"
    names = wa.get("roomNames") or {}
    # (2) walk the week; at every due event the briefing names the engine's room, and the seated room agrees
    seen = []
    n = 0
    ff = 0
    for _ in range(500):
        s, st = _schedule(_stack)
        pend = (st.get("pending") or {}).get("kind")
        if pend == "eviction-vote" or len(seen) >= 3:
            break
        if pend:
            _decide(_stack, st["pending"])
        elif s and s.get("due"):
            want = _STAGING.get(s["next"])
            if want:
                assert s.get("stagingRoom") == want, f"{s['next']} is due: the briefing must name the engine's room: {s}"
            _send(_stack, sid, f"Plain chat line {n}.", f"orw740b-{n}")
            n += 1
        elif st.get("timeOfDay") in ("night", "late-night"):
            _engine(_stack, "turnIn")
            _send(_stack, sid, f"Good morning {n}.", f"orw740b-wake-{n}")
            n += 1
        else:
            mu = (s or {}).get("minutesUntil")
            if isinstance(mu, int) and mu > 60:
                for k in range(mu // 5 - 12):
                    ff += 1
                    _engine(_stack, "noteMessage", {"messageId": f"orw740b-ff-{ff}"})
                continue
            _send(_stack, sid, f"Plain chat line {n}.", f"orw740b-{n}")
            n += 1
        w = _engine(_stack, "whereabouts") or {}
        ev = w.get("houseEvent")
        if ev and ev.get("room"):
            assert w.get("room") == ev["room"], f"the house is gathered in the event's room: {w.get('room')} vs {ev}"
            assert ev["room"] == _STAGING.get(ev["kind"]), f"{ev['kind']} is staged in {_STAGING.get(ev['kind'])}: {ev}"
            if ev["kind"] not in seen:
                seen.append(ev["kind"])
    assert seen, "the walk never reached a competition or ceremony in session"

"""A13 - the 2026-11-04 live playtest regression pack. Each scenario below is a bug the live reruns actually hit, driven through the REAL FE seams (maybe_hang_out -> _pre_resolve_npc_ceremony,
the pre-emission guard on a real board signature, the premiere hold) with a faked engine. Roles only.

  R1  hang out until the competition -> the engine stops AT the event -> the due event fires THE SAME TURN (not frozen behind the premiere hold, not a turn later)
  R2  the narrator stages the competition early (production hasn't called it) -> N-16 catches it on the board signature built from the real state
  R3  once the engine CLOCK is live the schedule - not the premiere message count - owns the hold (due => release at once)
  R4  with the entrances ON, once the toast is done there is NO message-count hold (nothing freezes the engine at phase=premiere)
"""
import asyncio
import importlib

import pytest

importlib.import_module("src.agent_tools")
ch = importlib.import_module("routes.chat_helpers")
oe = importlib.import_module("src.orwell_engine")


def _run(c):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(c)
    finally:
        loop.close()
        asyncio.set_event_loop(asyncio.new_event_loop())


@pytest.fixture(autouse=True)
def _clean():
    for u in ("a13",):
        ch.clear_social_runway(u); ch.clear_preresolve_debt(u); ch._PRE_RESOLVED_ADVANCE.pop(u, None); ch._PRODUCTION_HOLD.clear(); ch._HANGOUT_STEER.clear()
    yield


def _board(due, minutes, phase="hoh-competition", pending=None):
    return {"phase": phase, "moment": phase, "week": 1, "started": True, "pending": pending,
            "daySchedule": {"next": "hoh-competition", "phase": "afternoon", "due": due, "minutesUntil": minutes}}


def test_r1_hang_out_to_the_event_then_the_due_comp_fires_the_same_turn(monkeypatch):
    board = _board(False, 40)
    advances = []

    async def hang(expected_beat_seq=None, max_beats=None, user=None):
        board["daySchedule"].update(due=True, minutesUntil=0)           # the engine ran the clock to exactly the event
        return {"ok": True, "stopReason": "event-due", "beats": 2, "minutes": 40, "beatSeq": 5}

    async def state(user=None, **kw):
        return dict(board, daySchedule=dict(board["daySchedule"]))

    async def status(user=None):
        return {"phase": board["phase"], "pending": board["pending"]}

    async def advance(expected_beat_seq=None, idempotency_key=None, user=None):
        advances.append(1)
        board["pending"] = {"kind": "comp-round"}                       # the comp STAGES (the player's decision card opens)
        return {"event": {"beat": "hoh-competition", "content": "x"}, "announcements": []}

    monkeypatch.setattr(oe, "hang_out", hang)
    monkeypatch.setattr(oe, "get_game_state", state)
    monkeypatch.setattr(oe, "game_status", status)
    monkeypatch.setattr(oe, "advance_game", advance)
    st = dict(board, daySchedule=dict(board["daySchedule"]))
    assert _run(ch.maybe_hang_out("a13", st, "I'll hang out and chill until the competition starts")) is True
    assert "HANG OUT (engine-decided" in ch._HANGOUT_STEER[ch._runway_key("a13")]
    fresh = _run(oe.get_game_state(user="a13"))
    assert fresh["daySchedule"]["due"] is True
    _run(ch._pre_resolve_npc_ceremony("a13", fresh, retry=False, player_msg="I'll hang out and chill until the competition starts"))
    assert advances, "the DUE comp fired in the same turn as the hang-out"


def test_r2_a_competition_narrated_as_started_before_it_is_due_is_caught_on_the_real_signature():
    state = {"phase": "hoh-competition", "daySchedule": {"next": "hoh-competition", "phase": "afternoon", "due": False, "minutesUntil": 70}, "house": [], "player": {"id": "player", "name": "P"}}
    sig = ch._beat_signature({"phase": "hoh-competition", "pending": None}, state)
    assert sig["compNotDue"] is True
    live = ('"Locked in. Houseguests - take your spots." Sixteen bodies climb onto the platform, sixteen sets of hands find the wall, and the screens flicker to life.')
    assert ch._narration_claims_outcome(live, sig, sig), "N-16 must re-ground a competition staged before production called it"
    sig_due = ch._beat_signature({"phase": "hoh-competition", "pending": None}, dict(state, daySchedule={"next": "hoh-competition", "phase": "afternoon", "due": True, "minutesUntil": 0}))
    assert ch._narration_claims_outcome(live, sig_due, sig_due) is None, "once due the same prose is legitimate"


def test_r3_the_clock_owns_the_premiere_hold_once_the_day_has_started():
    ch.clear_social_runway("a13")
    for _ in range(ch._PREMIERE_SOCIAL_MESSAGES + 3):
        ch.note_premiere_turn("a13", {"phase": "premiere", "daySchedule": {"next": "hoh-competition", "due": False}})
    assert ch.premiere_is_holding("a13") is True, "not due: the clock holds it regardless of the message count"
    ch.note_premiere_turn("a13", {"phase": "premiere", "daySchedule": {"next": "hoh-competition", "due": True}})
    assert ch.premiere_is_holding("a13") is False, "DUE: released at once (the live bug froze a due comp behind the count)"


def test_r4_entrances_on_after_the_toast_nothing_freezes_the_engine():
    ch.clear_social_runway("a13")
    for _ in range(ch._PREMIERE_SOCIAL_MESSAGES * 3):
        ch.note_premiere_turn("a13", {"phase": "premiere", "premiere": {"entrance": {"stage": "done"}}})
    assert ch.premiere_is_holding("a13") is False
    assert ch._PREMIERE_MSGS.get(ch._runway_key("a13")) is None

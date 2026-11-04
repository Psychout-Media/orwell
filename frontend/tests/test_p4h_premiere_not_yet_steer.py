"""P4h (A's live premiere check, Coordinator 2026-11-04): after the premiere toast, "Can we start the HOH competition?" got "available whenever you want it, just say the word" - which
contradicts Ryne's ruling that PRODUCTION owns the schedule. The premiere has no engine clock (so no `daySchedule`), so the existing "production hasn't called it yet" steer never armed.
While the premiere hold is on, every framed turn must carry the in-fiction not-yet steer. Roles only."""
import importlib

importlib.import_module("src.agent_tools")
ch = importlib.import_module("routes.chat_helpers")

GS = {"started": True, "phase": "premiere", "week": 1}


def _fresh(u):
    ch.clear_social_runway(u)
    ch._SCHEDULE_STEER.pop(ch._runway_key(u), None)


def test_an_early_ask_during_the_premiere_hold_arms_the_not_yet_steer():
    u = "u-p4h-1"; _fresh(u)
    ch.note_premiere_turn(u, GS)
    steer = ch._SCHEDULE_STEER.get(ch._runway_key(u))
    assert steer, "the premiere hold must arm a not-yet steer"
    low = steer.lower()
    assert "hasn't called it yet" in low and "first hoh" in low or "head of household" in low
    assert "this afternoon" in low


def test_the_steer_never_offers_the_event_on_demand():
    u = "u-p4h-2"; _fresh(u)
    ch.note_premiere_turn(u, GS)
    low = ch._SCHEDULE_STEER[ch._runway_key(u)].lower()
    for bad in ("whenever you want", "just say the word", "available whenever"):
        assert bad not in low
    assert "cannot start" in low or "can't start" in low


def test_every_held_premiere_message_is_steered_and_the_steer_stops_when_the_hold_ends():
    u = "u-p4h-3"; _fresh(u)
    for k in range(1, ch._PREMIERE_SOCIAL_MESSAGES):
        ch._SCHEDULE_STEER.pop(ch._runway_key(u), None)
        ch.note_premiere_turn(u, GS)
        assert ch.premiere_is_holding(u) is True
        assert ch._SCHEDULE_STEER.get(ch._runway_key(u)), f"message {k}: still held, still steered"
    ch._SCHEDULE_STEER.pop(ch._runway_key(u), None)
    ch.note_premiere_turn(u, GS)                      # the morning's worth has passed
    assert ch.premiere_is_holding(u) is False
    assert not ch._SCHEDULE_STEER.get(ch._runway_key(u)), "once production has called it, no not-yet cue"


def test_a_non_premiere_phase_arms_nothing():
    u = "u-p4h-4"; _fresh(u)
    ch.note_premiere_turn(u, {"started": True, "phase": "hoh-competition", "week": 1})
    assert not ch._SCHEDULE_STEER.get(ch._runway_key(u))

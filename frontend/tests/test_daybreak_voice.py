"""Thursday dry run: the premiere's day-break is committed by the stall-nudge's SILENT advance, not the pre-resolve, so the night->morning narration steer was never armed and the narrator kept
the house in bed ~7 turns after the board said Morning. The FIRST board that carries the day schedule is that crossing: arm the one-shot steer. Roles only."""
import importlib

importlib.import_module("src.agent_tools")
ch = importlib.import_module("routes.chat_helpers")


def test_the_premiere_day_break_arms_its_narration_steer_once():
    """Thursday dry run: the day-break is committed by the nudge's silent advance, so the night->morning steer was never armed and the narrator kept the house in bed ~7 turns after the board
    said Morning. The FIRST board that carries the day schedule is that crossing: arm the one-shot steer."""
    u = "a13-db"
    ch.clear_social_runway(u)
    ch._DAY_BREAK_STEER.pop(ch._runway_key(u), None)
    ch.note_premiere_turn(u, {"phase": "premiere"})
    assert ch._runway_key(u) not in ch._DAY_BREAK_STEER, "no schedule yet: no crossing"
    ch.note_premiere_turn(u, {"phase": "premiere", "daySchedule": {"next": "hoh-competition", "due": False}})
    steer = ch._DAY_BREAK_STEER.pop(ch._runway_key(u), None)
    assert steer and "NEW DAY" in steer and "first morning dawns" in steer
    ch.note_premiere_turn(u, {"phase": "premiere", "daySchedule": {"next": "hoh-competition", "due": False}})
    assert ch._runway_key(u) not in ch._DAY_BREAK_STEER, "armed exactly once"
    ch.clear_social_runway(u)


def test_the_day_break_steer_is_premiere_only_and_a_reset_drops_it():
    """ORW-38 mutation sweep (#2127): a schedule board outside the premiere must not arm the steer, and a reset/end must drop an armed-but-unspoken one."""
    u = "a13-db-2"
    ch.clear_social_runway(u)
    ch.note_premiere_turn(u, {"phase": "hoh-competition", "daySchedule": {"next": "hoh-competition", "due": False}})
    assert ch._runway_key(u) not in ch._DAY_BREAK_STEER, "not the premiere: no crossing"
    ch.note_premiere_turn(u, {"phase": "premiere", "daySchedule": {"next": "hoh-competition", "due": False}})
    assert ch._runway_key(u) in ch._DAY_BREAK_STEER
    ch.clear_social_runway(u)
    assert ch._runway_key(u) not in ch._DAY_BREAK_STEER, "a reset drops a pending day-break steer"

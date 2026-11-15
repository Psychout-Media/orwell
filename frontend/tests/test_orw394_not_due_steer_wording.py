"""ORW-394: the not-due steers must label the event from the engine's schedule and say "tomorrow" when the schedule does - never "this afternoon" when it is not today. Roles only."""
import importlib

importlib.import_module("src.agent_tools")
ch = importlib.import_module("routes.chat_helpers")


def test_premiere_night_steer_says_tomorrow_not_this_afternoon():
    low = ch._premiere_not_yet_steer({"next": "hoh-competition", "phase": "afternoon", "due": False, "tomorrow": True}).lower()
    assert "tomorrow afternoon" in low
    assert "this afternoon" not in low


def test_premiere_same_day_steer_says_this_part_of_day():
    low = ch._premiere_not_yet_steer({"next": "hoh-competition", "phase": "afternoon", "due": False}).lower()
    assert "this afternoon" in low and "tomorrow" not in low


def test_premiere_without_clock_keeps_this_afternoon():
    assert "this afternoon" in ch._premiere_not_yet_steer().lower()


def test_not_due_steer_labels_from_schedule_and_says_tomorrow():
    low = ch._schedule_not_due_steer("premiere", "afternoon", "hoh-competition", True).lower()
    assert "hoh competition" in low and "premiere" not in low
    assert "tomorrow afternoon" in low and "this afternoon" not in low


def test_not_due_steer_same_day_event():
    low = ch._schedule_not_due_steer("nominations", "evening", "nominations", False).lower()
    assert "this evening" in low and "tomorrow" not in low


def test_not_due_steer_legacy_call_unchanged():
    low = ch._schedule_not_due_steer("nominations", "").lower()
    assert "nominations" in low and "later today" in low

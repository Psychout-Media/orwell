"""ORW-258 (Ryne 2026-11-11: every event gets its own day): while the next event waits behind its night, the in-world header names the event that belongs to TODAY. The HOH day reads HOH,
not Nominations. Roles only."""
import importlib

ch = importlib.import_module("routes.chat_helpers")


def _state(phase, tod, today=None):
    ds = {"next": phase, "phase": "evening", "due": False, "minutesUntil": 700}
    if today:
        ds["todaysEvent"] = today
    return {"started": True, "week": 1, "phase": phase, "timeOfDay": tod, "daySchedule": ds}


def test_the_hoh_day_header_names_the_hoh_not_nominations():
    assert ch._format_game_moment(_state("nominations", "evening", today="hoh-competition")) == "Week 1 · HOH competition · Evening"


def test_on_its_own_day_the_header_names_the_event():
    assert ch._format_game_moment(_state("nominations", "evening")) == "Week 1 · Nominations · Evening"


def test_a_state_without_a_schedule_is_unchanged():
    s = {"started": True, "week": 2, "phase": "eviction", "timeOfDay": "night"}
    assert ch._format_game_moment(s) == "Week 2 · Eviction night · Night"

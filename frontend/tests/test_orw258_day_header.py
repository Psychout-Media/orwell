"""ORW-258 (Ryne 2026-11-11: every event gets its own day): while the next event waits behind its night, the in-world header names the event that belongs to TODAY. The HOH day reads HOH,
not Nominations. Roles only."""
import importlib

ch = importlib.import_module("routes.chat_helpers")


def _state(phase, tod, today=None):
    ds = {"next": phase, "phase": "evening", "due": False, "minutesUntil": 700}
    if today:
        ds["todaysEvent"] = today
        ds["headerPhase"] = today  # ORW-775: the engine applies the rule and sends the header's phase
    return {"started": True, "week": 1, "phase": phase, "timeOfDay": tod, "daySchedule": ds}


def test_the_hoh_day_header_names_the_hoh_not_nominations():
    assert ch._format_game_moment(_state("nominations", "evening", today="hoh-competition")) == "Week 1 · HOH competition · Evening"


def test_on_its_own_day_the_header_names_the_event():
    assert ch._format_game_moment(_state("nominations", "evening")) == "Week 1 · Nominations · Evening"


def test_a_state_without_a_schedule_is_unchanged():
    s = {"started": True, "week": 2, "phase": "eviction", "timeOfDay": "night"}
    assert ch._format_game_moment(s) == "Week 2 · Eviction night · Night"


def test_orw479_the_header_says_early_morning_when_the_status_does():
    # ORW-479: 4:55am before the house wakes: the status has earlyMorning and the bubble header must agree with the HUD
    for tod in ("morning", "late-night"):
        s = {**_state("nominations", tod), "earlyMorning": True}
        assert ch._format_game_moment(s) == "Week 1 · Nominations · Early morning", tod
    # past the wake-up call the flag is absent: Morning stays Morning; other bands never become Early morning
    assert ch._format_game_moment(_state("nominations", "morning")) == "Week 1 · Nominations · Morning"
    assert ch._format_game_moment({**_state("nominations", "evening"), "earlyMorning": True}) == "Week 1 · Nominations · Evening"


def test_orw705_day_two_before_the_first_hoh_names_the_hoh_not_the_premiere():
    # PT-11: the engine phase stays `premiere` through Day 2 until the first HOH STARTS; the stamp named "Premiere" on a Day-2 morning.
    s = _state("premiere", "morning")
    s["dayNumber"] = 2
    s["daySchedule"]["next"] = "hoh-competition"
    s["daySchedule"]["headerPhase"] = "hoh-competition"  # ORW-775: the engine applies the PT-11 rule (tests/unit/headerPhase775.test.ts)
    assert ch._format_game_moment(s) == "Week 1 · HOH competition · Morning"


def test_orw705_the_premiere_night_itself_still_reads_premiere():
    s = _state("premiere", "evening")
    s["dayNumber"] = 1
    s["daySchedule"]["next"] = "hoh-competition"
    assert ch._format_game_moment(s) == "Week 1 · Premiere · Evening"

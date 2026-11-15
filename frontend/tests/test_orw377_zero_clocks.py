"""ORW-377 - zero clocks in the house (Ryne, playtest 2026-11-15). The narrator/houseguests name the PART OF THE DAY, never a clock time; a clock-time SENTENCE is dropped (never the scene); what the
player sees is Day N + the band. PRESENTATION ONLY: the engine keeps its internal clock (pinned engine-side in tests/unit/zeroClocks.test.ts). OFF is byte-identical. Roles only, no model calls."""
import asyncio
import json
import re
from pathlib import Path

import pytest

pytestmark = pytest.mark.usefixtures("non_game_text_routing")

CLOCK_RE = re.compile(r"\b\d{1,2}:\d{2}\b|\b\d{1,2}\s?(?:am|pm)\b", re.IGNORECASE)


@pytest.fixture
def setting(monkeypatch):
    import src.settings as st
    real = st.get_setting
    state = {"v": True}
    monkeypatch.setattr(st, "get_setting", lambda k, d=None: state["v"] if k == "zero_clocks" else real(k, d))
    return state


def _guard(text):
    from src import agent_loop as al
    return asyncio.get_event_loop().run_until_complete(al._pre_emission_outcome_guard(text, "u"))


def test_default_is_on():
    from src.settings import DEFAULT_SETTINGS
    assert DEFAULT_SETTINGS["zero_clocks"] is True


@pytest.mark.parametrize("clocky", [
    "It's 8:15 in the morning.", "Quarter past eight.", "At 3am the house is dark.", "It's 6:15 and nobody is up.", "Half past three, and the kitchen hums.",
    "She checks the time: eight o'clock.", "Three in the morning, and the hallway is silent.", "It's 11 pm.", "Twenty past six by the light.", "It's eight-thirty.",
    "Twelve noon on the dot.", "At midnight sharp the lights go.", "A quarter to eight, someone says.", "It is 9:40 a.m.",
])
def test_clock_time_sentences_are_dropped_but_the_scene_survives(setting, clocky):
    text = f"The kettle clicks off. {clocky} The player stays on the couch."
    out = _guard(text)
    assert "The kettle clicks off." in out and "The player stays on the couch." in out
    assert not CLOCK_RE.search(out) and clocky not in out


@pytest.mark.parametrize("fine", [
    "Three of us are in the kitchen.", "It has been seven days.", "It's Day 4.", "They talk for two hours.", "Noon light falls across the floor.", "The midnight snack is gone.",
    "No one in the morning would dare.", "Round 3 of 5.", "Seven of them nod along.", "A few hours into the night, the house goes quiet.", "Ten of them gather at the table.",
])
def test_non_clock_numbers_and_band_words_survive(setting, fine):
    text = f"{fine} The door opens."
    assert _guard(text) == text


def test_off_is_byte_identical_nothing_dropped(setting):
    setting["v"] = False
    text = "It's 6:15 and quarter past eight and 3am.\n\nShe waits."
    assert _guard(text) == text


def test_detection_is_pure_and_fail_open():
    from src.zero_clocks import sentence_states_zero_clock_time_raw as d
    assert d("It's 6:15.") and not d("") and not d(None) and not d("Nothing here.")


# ---- what the narrator is handed ----
def test_tool_output_the_model_reads_has_the_band_not_the_clock(setting):
    from src.zero_clocks import scrub_tool_output
    raw = json.dumps({"clockLabel": "4:15am, Day 5", "timeOfDay": "late-night", "daySchedule": {"next": "x", "minutesUntil": 45, "due": False}, "nested": [{"clockLabel": "3:05pm, Day 2"}]})
    out = scrub_tool_output(raw)
    assert "small hours, Day 5" in out and "afternoon, Day 2" in out and "minutesUntil" not in out and not CLOCK_RE.search(out)
    setting["v"] = False
    assert scrub_tool_output(raw) == raw


def test_format_tool_result_applies_the_scrub(setting):
    from src.tool_execution import format_tool_result
    res = {"output": json.dumps({"clockLabel": "9:40am, Day 1"}), "exit_code": 0}
    assert "9:40" not in format_tool_result("status", res) and "morning, Day 1" in format_tool_result("status", res)
    setting["v"] = False
    assert "9:40am, Day 1" in format_tool_result("status", res)


@pytest.mark.parametrize("label,band", [("4:15am, Day 4", "small hours"), ("1:00am, Day 2", "late night"), ("6:30am, Day 2", "early morning"), ("3:20pm, Day 3", "afternoon"),
                                        ("9:10pm, Day 3", "night"), ("5:00pm, Day 1", "evening"), ("12:15pm, Day 1", "midday"), ("9:40am, Day 1", "morning")])
def test_band_label_mirrors_the_engine_bands(label, band):
    from src.zero_clocks import band_label
    assert band_label(label) == f"{band}, " + label.split(", ")[1]


def test_turn_in_note_and_reground_quote_the_band(setting):
    from src import agent_loop as al
    out = json.dumps({"status": {"timeOfDay": "morning", "clockLabel": "4:15am, Day 4"}})
    note = al._bedtime_direct_note(out)
    assert "small hours, Day 4" in note and not CLOCK_RE.search(note)
    setting["v"] = False
    assert "4:15am, Day 4" in al._bedtime_direct_note(out)


def test_held_and_warning_steers_carry_no_minutes(setting):
    from routes import chat_helpers as ch
    for steer in (ch.engine_held_note({"next": "nominations", "minutesUntil": 45, "reason": "schedule"}), ch._production_warning_steer("nominations", 20)):
        assert not re.search(r"\d", steer.replace("Day", ""))
    setting["v"] = False
    assert "20 in-game minutes" in ch._production_warning_steer("nominations", 20)
    assert "in about 45 minutes" in ch.engine_held_note({"next": "nominations", "minutesUntil": 45})


def test_get_moment_prompt_requests_zero_clocks_only_when_on(setting, monkeypatch):
    from src import orwell_engine as oe
    seen = []

    async def fake_call(name, args=None, user=None, timeout=None):
        seen.append(dict(args or {}))
        return {}

    monkeypatch.setattr(oe, "_call", fake_call)
    asyncio.get_event_loop().run_until_complete(oe.get_moment_prompt("x"))
    setting["v"] = False
    asyncio.get_event_loop().run_until_complete(oe.get_moment_prompt("x"))
    assert seen[0].get("zeroClocks") is True and "zeroClocks" not in seen[1]


# ---- what the player sees ----
def test_player_visible_labels_are_day_plus_band_no_minutes():
    from routes import chat_helpers as ch
    for tod in ("morning", "afternoon", "evening", "night", "late-night"):
        stamp = ch._format_game_moment({"started": True, "week": 1, "phase": "nominations", "timeOfDay": tod, "clockLabel": "4:15am, Day 5"})
        assert stamp and not CLOCK_RE.search(stamp)
    js = Path(__file__).resolve().parent.parent / "static" / "js"
    panel = (js / "orwellStatusPanel.js").read_text()
    assert "clockLabel" not in panel and "timeOfDay" in panel  # the HUD chip is "Morning, Day 1" from the band + dayNumber
    assert 'return p === "night" ? "tonight" : "this " + p;' in panel and 'return "tomorrow " + p;' in panel  # what's next: "this evening" / "tomorrow afternoon"
    for f in ("orwellChapters.js", "chatRenderer.js"):
        assert "clockLabel" not in (js / f).read_text()


def test_settings_toggle_exists():
    root = Path(__file__).resolve().parent.parent
    assert 'id="set-zeroClocksToggle"' in (root / "static" / "index.html").read_text()
    assert "zero_clocks" in (root / "static" / "js" / "settings.js").read_text()

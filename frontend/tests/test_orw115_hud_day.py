"""ORW-115 (Ryne 2026-11-06: "Time of day only"): the HUD chip reads "Morning, Day 1" - the time-of-day word plus the day number from the public status (`dayNumber`, the same day as the narrator's clock label),
never exact minutes. Source pin on the one render site (the engine side is tests/unit/hudDayNumber.test.ts)."""
import pathlib
import re

SRC = (pathlib.Path(__file__).resolve().parents[1] / "static" / "js" / "orwellStatusPanel.js").read_text(encoding="utf-8")


def test_the_chip_appends_the_day_number_to_the_time_of_day_label():
    assert re.search(r'todLabel\(st\.timeOfDay\)\s*\+\s*\(.*Number\.isInteger\(st\.dayNumber\).*", Day "\s*\+\s*st\.dayNumber', SRC)


def test_no_exact_minutes_reach_the_chip():
    chip = re.search(r'const todEl = el\.querySelector\("#os-tod"\);.*?\n', SRC).group(0).split("//")[0]  # the code, not the trailing comment
    assert "clockLabel" not in chip and "minutes" not in chip.lower()

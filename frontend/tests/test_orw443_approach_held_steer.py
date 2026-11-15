"""ORW-443: the one-turn 'approach held' steer. Present only when the engine flag is true; closed-set (no digits, no clock words)."""
import importlib
import re

importlib.import_module("src.agent_tools")
ch = importlib.import_module("routes.chat_helpers")


def test_steer_only_when_approach_held():
    assert ch._approach_held_steer({}) == ""
    assert ch._approach_held_steer(None) == ""
    assert ch._approach_held_steer({"approachHeld": False}) == ""
    assert ch._approach_held_steer({"approachHeld": "yes"}) == ""
    s = ch._approach_held_steer({"approachHeld": True})
    assert "NO ONE NEW STEPS UP" in s and "talk among themselves" in s and "demand" in s


def test_steer_has_no_digits_or_clock_words():
    s = ch._approach_held_steer({"approachHeld": True})
    assert not re.search(r"\d", s)
    assert not re.search(r"\b(am|pm|o'clock|minutes?|hours?)\b", s, re.I)

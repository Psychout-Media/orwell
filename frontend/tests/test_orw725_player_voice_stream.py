"""ORW-725 - the player-voice net through the REAL stream loop (stubbed model, no network, roles only): a first-person line the player never typed, and the answer after it, are never emitted and never stored;
houseguest speech and honest narration stream untouched; flag off streams as today; the belt is counted only when a sentence was withheld."""
import importlib
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))
_drive = importlib.import_module("test_orw408_sentence_rewrite")._drive

pytestmark = [pytest.mark.usefixtures("non_game_text_routing"), pytest.mark.usefixtures("zero_clocks_off")]

LIVE = {"started": True, "asleep": [], "daySchedule": {}}
FP = "I lean back against the counter and give Houseguest A the honest answer. "
ANSWER = '"Both, if I am any good at it." '
NPC = 'Houseguest A — "That is worse than the hands." He says it quick and dry. '
SCENE = "The kettle ticks. "


def test_the_invented_first_person_line_and_answer_are_never_emitted_nor_stored(monkeypatch):
    emitted, _, stored, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": [SCENE, FP, ANSWER, NPC]}], state=LIVE, flag="0")
    assert "I lean back" not in emitted and "Both, if I am" not in emitted
    assert "That is worse than the hands" in emitted and "The kettle ticks" in emitted
    assert stored and "I lean back" not in stored[0] and "Both, if I am" not in stored[0] and "worse than the hands" in stored[0]


def test_the_belt_is_counted_only_when_something_was_withheld(monkeypatch):
    from src import agent_loop as al
    seen = []
    monkeypatch.setattr(al, "_note_belt", lambda owner, belt, n=1: seen.append((belt, n)))
    _drive(monkeypatch, rounds_scripts=[{"deltas": [SCENE, NPC]}], state=LIVE, flag="0", owner="pv-clean")
    assert not [b for b, _ in seen if b == "player-voice-withheld"]
    _drive(monkeypatch, rounds_scripts=[{"deltas": [SCENE, FP, ANSWER, NPC]}], state=LIVE, flag="0", owner="pv-hit")
    assert [n for b, n in seen if b == "player-voice-withheld"] and sum(n for b, n in seen if b == "player-voice-withheld") >= 2


def test_flag_off_streams_as_today(monkeypatch):
    monkeypatch.setenv("ORWELL_PLAYER_VOICE_GUARD", "0")
    emitted, _, _, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": [SCENE, FP, ANSWER, NPC]}], state=LIVE, flag="0")
    assert "I lean back" in emitted and "Both, if I am" in emitted


def test_before_the_game_starts_nothing_is_touched(monkeypatch):
    emitted, _, _, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": [SCENE, FP, ANSWER, NPC]}], state={"started": False}, flag="0")
    assert "I lean back" in emitted

"""ORW-940: the player said "go back to sleep" and the narrator moved them out of bed in the same turn.

A moveTo for the player in the same turn as their own turnIn (the bed or the doze to the wake-up call) is refused, unless the player's own message asked to go somewhere. BEHAVIOURAL: the real
agent loop with a scripted model (the ORW-310 harness); the executed tools are what reaches the engine. Roles only.
"""
import pytest

from test_orw310_bedtime_belt import _drive, _res

_CALLS = [{"name": "turnIn", "arguments": "{}"}, {"name": "moveTo", "arguments": '{"room": "kitchen"}'}]


def _run(monkeypatch, text, turn_in=None):
    _, _, _, executed = _drive(monkeypatch, text=text, scripts=[{"calls": _CALLS}, {"deltas": ["The house is quiet."]}],
                               turn_in_result=turn_in if turn_in is not None else _res("morning"))
    return executed


@pytest.mark.parametrize("text", [
    "I go back to my bunk and go back to sleep until the house is up.",
    "I sleep.",
])
def test_a_move_after_the_players_own_bed_is_refused(monkeypatch, text):
    assert "moveTo" not in _run(monkeypatch, text)


def test_the_player_who_asked_to_go_somewhere_still_moves(monkeypatch):
    assert "moveTo" in _run(monkeypatch, "I sleep, then I go to the kitchen.")


def test_a_held_bedtime_does_not_block_a_move(monkeypatch):
    held = _res("morning", held={"next": "bedtime", "minutesUntil": 30})
    assert "moveTo" in _run(monkeypatch, "I sleep.", turn_in=held)

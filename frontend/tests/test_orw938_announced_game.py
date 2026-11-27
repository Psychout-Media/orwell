"""ORW-938: once the house has been told the game, the exit lines are written for THAT game. Roles only."""
from src.orwell_gen_competitions import _synthesis_messages

_STAGING = {"type": "mental", "format": "quiz", "winner": {"name": "A"}, "dropOrder": [{"name": "B"}], "participants": [{"name": "A"}, {"name": "B"}],
            "library": {"name": "House Trivia", "premise": "Answer or step down."}}


def test_an_announced_game_is_held_to():
    user = _synthesis_messages(dict(_STAGING, announced=True))[1]["content"]
    assert "ALREADY ANNOUNCED" in user and "House Trivia — Answer or step down." in user and "way of going out of THIS game" in user
    assert "DEPART from freely" not in user


def test_otherwise_the_writer_may_still_depart():
    assert "DEPART from freely" in _synthesis_messages(_STAGING)[1]["content"]

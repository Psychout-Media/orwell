"""ORW-1180: the narration walked the player to the bathroom/shower and back through the kitchen though the engine kept them in the backyard (no move committed). The presence guard holds those sentences. Roles only."""
import pytest

from src import predisplay_check as pd
from src.house_rooms import rooms_named_in

_BOARD = {"whereabouts": {"room": "backyard"}}


def _split(monkeypatch, text):
    monkeypatch.setattr(pd, "_fresh_state", lambda owner: (_BOARD, False))
    return pd.split_at_first_conflict(text, "orw1180")


@pytest.mark.parametrize("sentence", [
    "You head to the shower, water running over your shoulders.",
    "You walk back through the kitchen, dripping on the tiles.",
    "You walk back through the kitchen.",
    "You step into the bathroom and close the door.",
])
def test_a_room_change_the_engine_did_not_commit_is_held(monkeypatch, sentence):
    got = _split(monkeypatch, "Ana Reed looks away. " + sentence)
    assert got is not None and got.sentence.strip() == sentence
    assert [c.fact for c in got.conflicts] == [pd.FACT_PLAYER_ROOM]


@pytest.mark.parametrize("sentence", [
    "You sit on the pool deck, towel around your shoulders.",
    "You hear the shower running inside.",
    "You could head to the shower if you wanted.",
    "You watch her walk through the kitchen window.",
])
def test_nothing_else_is_touched(monkeypatch, sentence):
    assert _split(monkeypatch, sentence) is None


def test_the_shower_names_the_bathroom():
    assert rooms_named_in("the shower") == [frozenset({"bathroom"})]


def test_a_committed_move_is_not_held(monkeypatch):
    monkeypatch.setattr(pd, "_fresh_state", lambda owner: ({"whereabouts": {"room": "bathroom"}}, False))
    assert pd.split_at_first_conflict("You head to the shower, water running.", "orw1180") is None

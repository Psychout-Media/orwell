"""ORW-1003: the narration placed the player in a room they never went to; the engine kept their real room, so the player read the wrong one. BEHAVIOURAL on the presence guard with a stubbed board.
Roles only: the engine has the player in the living room.
"""
import pytest

from src import predisplay_check as pd

_BOARD = {"whereabouts": {"room": "living-room"}}


def _split(monkeypatch, text, **kw):
    monkeypatch.setattr(pd, "_fresh_state", lambda owner: (_BOARD, False))
    return pd.split_at_first_conflict(text, "orw1003", **kw)


@pytest.mark.parametrize("sentence", [
    "You drift into the bathroom, the tiles cold.",
    "You're back in the kitchen now.",
    "You find yourself alone in the storage room.",
    "You follow her out into the backyard.",
])
def test_a_sentence_putting_the_player_elsewhere_is_held_for_a_rewrite(monkeypatch, sentence):
    got = _split(monkeypatch, "Ana Reed looks up. " + sentence)
    assert got is not None and got.keep.strip() == "Ana Reed looks up." and got.sentence.strip() == sentence
    assert [c.fact for c in got.conflicts] == [pd.FACT_PLAYER_ROOM] and got.conflicts[0].detail == "the living room"
    assert "do not move or place them anywhere else" in pd.continuation_messages([], got.keep, got.conflicts)[-1]["content"]


@pytest.mark.parametrize("sentence", [
    "You sink deeper into the couch in the living room.",
    "You could go to the kitchen if you wanted.",
    "Do you walk into the bathroom?",
    'Ana Reed says, "You walk into that kitchen and they pounce."',
    "You hear laughter from the kitchen.",
])
def test_nothing_else_is_touched(monkeypatch, sentence):
    assert _split(monkeypatch, sentence) is None


def test_the_goodnight_turn_does_not_judge_where_the_player_is(monkeypatch):
    from src.agent_loop import _pd_bed_skip
    assert _pd_bed_skip(None) == () and _pd_bed_skip({"started": True}) == (pd.FACT_PLAYER_ROOM,)
    assert _split(monkeypatch, "You drift into the bathroom.", skip=_pd_bed_skip({})) is None

"""Live hotfix: the auto-move belt teleported an engaged player. They were talking about "the Palmetto room" in the living room and got moved there; the others stayed.

Only the player's own INTENT TO GO moves them. BEHAVIOURAL: the real agent loop with a scripted model; the move belt's extraction is stubbed to answer the room the talk named, and the engine's
`move_to` is recorded. Roles only.
"""
import pytest

from src import agent_loop as al
from test_orw310_bedtime_belt import _drive

NAMES = {"bedroom-b": "Palmetto Quarters", "living-room": "The Lounge"}


@pytest.mark.parametrize("text", [
    "We were talking about the Palmetto room, right?",
    "What do you all think about the Palmetto room?",
    "Honestly the kitchen is where all the drama happens.",
    "Do you want to go to the bathroom or something?",
    "I keep thinking about that bedroom thing from yesterday.",
    "You should go to the backyard if you want air.",
    "I went to the kitchen earlier and he was there.",
])
def test_talking_about_a_room_is_not_going_there(text):
    assert not al._player_asked_to_move(text, NAMES), text


@pytest.mark.parametrize("text", [
    "I go to the kitchen.",
    "I'll head into the Palmetto Quarters.",
    "Let's go to the backyard.",
    "I head back to my bunk.",
    "Walk into the living room.",
    "I go outside.",
    "I'll follow them.",
    "Okay, then I walk over to the lounge.",
])
def test_an_intent_to_go_moves(text):
    assert al._player_asked_to_move(text, NAMES), text


def _run(monkeypatch, text, narration):
    moves = []
    from src import orwell_engine as oe
    from src import agent_loop

    async def fake_move(room, user=None, **k):
        moves.append(room)
        return {"ok": True}

    async def fake_extract(*a, **k):
        return '{"room":"bedroom-b"}'

    monkeypatch.setattr(oe, "move_to", fake_move)
    monkeypatch.setattr(agent_loop, "_move_player_extract", fake_extract)
    monkeypatch.setattr(agent_loop, "_season_room_names", lambda owner: NAMES)
    _drive(monkeypatch, text=text, scripts=[{"deltas": [narration]}], status={"started": True, "phase": "social", "timeOfDay": "evening", "pending": None})
    return moves


NARRATION = "You drift into the Palmetto Quarters with the others, the bunks dim, and someone sits down beside you."


def test_the_live_case_leaves_the_player_where_they_are(monkeypatch):
    assert _run(monkeypatch, "We were talking about the Palmetto room.", NARRATION) == []


def test_a_player_who_says_they_go_is_still_followed(monkeypatch):
    assert _run(monkeypatch, "I go to the Palmetto Quarters.", NARRATION) == ["bedroom-b"]

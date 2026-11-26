"""ORW-1008 (prod 2026-11-26): the post-reply move belt misread the player twice. Words that only say which room is the player's (affiliation) moved them when the narration walked them
there; an explicit "let's go to the <themed> room" was vetoed because the narration named other rooms. The engine commits an explicit move before the reply (ORW-419); the belt must
(a) never move on affiliation-only words and (b) never veto the player's own explicit request with the narration's wording. Roles only; no live model (the extraction is a stub)."""
import asyncio
import importlib

import pytest

al = importlib.import_module("src.agent_loop")
orwell_engine = importlib.import_module("src.orwell_engine")
llm_core = importlib.import_module("src.llm_core")
from src.house_rooms import themed_rooms_in

NAMES = {"living-room": "The Lagoon Living Room", "bedroom-b": "The Palmetto Bedroom", "bathroom": "The Tidepool Bathroom", "kitchen": "The Galley Kitchen"}
BATH_NARRATION = "In the Tidepool Bathroom the tap drips. Two houseguests are already talking in low voices by the mirror, and you can hear the party down the hall."


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _wire(monkeypatch, room, moves):
    async def fake_llm(*a, **k):
        return '{"room":"%s"}' % room

    async def fake_move_to(r, expected_beat_seq=None, user=None):
        moves.append(r)
        return {"whereabouts": {"room": r, "present": [], "nearby": []}}

    monkeypatch.setattr(llm_core, "llm_call_async", fake_llm)
    monkeypatch.setattr(orwell_engine, "move_to", fake_move_to)
    monkeypatch.setattr(al, "_season_room_names", lambda owner: NAMES)


def test_the_player_room_alias_for_a_bedroom_name():
    assert themed_rooms_in("let's go to the Palmetto room", NAMES) == ["bedroom-b"]


@pytest.mark.parametrize("words", [
    "My bed is in the Palmetto room, by the window.",
    "I'm in the Palmetto room, that's where my bed is.",
    "The Palmetto Bedroom is my room.",
    "I sleep in the Palmetto room with Sam.",
    "That's my bed over there.",
    "I claimed a bed! You all should jump on it! Im in the Palmetto room!",
])
def test_affiliation_words_never_move_the_player_even_when_the_narration_walks_them(monkeypatch, words):
    moves = []
    _wire(monkeypatch, "bedroom-b", moves)
    out = _run(al._auto_move_player("You cross into the Palmetto Bedroom and sit on the edge of the bed.", words, "url", "m", {}, "owner"))
    assert out is False and moves == []


@pytest.mark.parametrize("words", [
    "Let's go to the Palmetto room.",
    "let's go to the palmetto room with Sam and Alex",
    "ok, I head to the Palmetto Bedroom",
    "I walk into the Palmetto room and sit.",
    "Lets go to the Palmetto room.",
])
def test_an_explicit_request_is_not_vetoed_by_the_narrations_wording(monkeypatch, words):
    moves = []
    _wire(monkeypatch, "bedroom-b", moves)
    out = _run(al._auto_move_player(BATH_NARRATION, words, "url", "m", {}, "owner"))
    assert out is True and moves == ["bedroom-b"]


@pytest.mark.parametrize("words", [
    "I'll go to the Palmetto room later.",
    "Let's not go to the Palmetto room.",
    "I tell Sam \"let's go to the Palmetto room\" and stay.",
    "Can we go to the Palmetto room?",
    "I ask a houseguest to step out to the Palmetto room with me.",
])
def test_hedged_negated_quoted_or_someone_elses_move_keeps_the_veto(monkeypatch, words):
    moves = []
    _wire(monkeypatch, "bedroom-b", moves)
    out = _run(al._auto_move_player(BATH_NARRATION, words, "url", "m", {}, "owner"))
    assert out is False and moves == []

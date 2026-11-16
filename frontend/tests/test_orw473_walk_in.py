"""ORW-473: walking in on a private talk. The engine chooses each houseguest's reaction from their own sheet; the front end hands the narrator the manner, never a subject."""
import importlib

chat_helpers = importlib.import_module("routes.chat_helpers")

_WALKED = {"room": "kitchen", "with": [{"id": "npc:1", "name": "Role A"}, {"id": "npc:2", "name": "Role B"}], "reactions": [
    {"id": "npc:1", "name": "Role A", "line": "breaks off and goes quiet, changing the subject"},
    {"id": "npc:2", "name": "Role B", "line": "welcomes the player in and pulls them into the conversation"}]}


def test_the_directive_hands_over_each_reaction_and_forbids_inventing_the_subject():
    d = chat_helpers._walked_in_directive(_WALKED)
    assert "THE PLAYER JUST WALKED IN ON A PRIVATE TALK in the kitchen between Role A and Role B" in d
    assert "- Role A breaks off and goes quiet, changing the subject." in d
    assert "- Role B welcomes the player in and pulls them into the conversation." in d
    assert "never invent the subject" in d and "chosen from that houseguest's own character" in d


def test_nothing_to_voice_fails_open():
    for bad in (None, {}, "x", {"reactions": []}, {"reactions": [{"name": "Role A", "line": "x"}]}, {"reactions": [{"name": "A"}, {"name": "B"}]}):
        assert chat_helpers._walked_in_directive(bad) is None


def test_the_framing_adds_the_directive_fail_open():
    src = open(chat_helpers.__file__, encoding="utf-8").read()
    i = src.index('_walk = _walked_in_directive(game_state.get("walkedIn"))')
    assert "walk-in framing skipped" in src[i:i + 500]

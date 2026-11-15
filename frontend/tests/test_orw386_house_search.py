"""ORW-386 — "Look for Miguel. Where is he?": a search turn hands the narrator the engine's house search (each houseguest's ROOM
and whether the player can walk in), and the headcount wall catches a wrong asleep count or an "empty" claim about an occupied
room. Roles only; no model calls; no engine."""
import asyncio
import importlib

import pytest

chat_helpers = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")

_USER = "u-orw386"


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


@pytest.fixture(autouse=True)
def _clean():
    chat_helpers._DESYNC_REGROUND.pop(_USER, None)
    yield
    chat_helpers._DESYNC_REGROUND.pop(_USER, None)


# the live prompts of 2026-11-14, Day 2, 7:11am
LIVE_PROMPTS = (
    "Look for Miguel. Where is he?",
    "Did you look in every room of the entire house?",
    "Check every room, the bedrooms, bathroom, closets, backyard.",
    "Go talk to Janelle! WHERE IS EVERYBODY?!",
)


def test_search_turns_are_recognised():
    for p in LIVE_PROMPTS:
        assert chat_helpers._is_house_search(p), p
    for p in ("where is Marisol?", "go find Miguel", "Can you check for Jett?", "search the house"):
        assert chat_helpers._is_house_search(p), p


def test_ordinary_turns_are_not_searches():
    for p in ("I tell Janelle I am voting with her.", "How are you feeling?", "Let's go look at the pool.", "where is the bathroom", "", None, "I will find a way to win."):
        assert not chat_helpers._is_house_search(p), p


def _search(hidden="bedroom A, open - the player can walk in", access="open", room="bedroom-a"):
    return {"room": "backyard", "present": [{"id": "npc:15", "name": "Janelle Park"}], "nearby": [], "search": {
        "asleepCount": 11,
        "houseguests": [
            {"id": "npc:10", "name": "Miguel Ortega", "status": "awake", "room": room, "access": access, "fact": hidden},
            {"id": "npc:14", "name": "Marisol Vega", "status": "awake", "room": room, "access": access, "fact": hidden},
            {"id": "npc:11", "name": "Jett Wooten", "status": "awake", "room": "living-room", "access": "open", "fact": "living room, open - the player can walk in"},
            {"id": "npc:15", "name": "Janelle Park", "status": "here", "room": "backyard", "access": "open", "fact": "here with you in the backyard"},
            {"id": "npc:1", "name": "Sleepy One", "status": "asleep", "room": "bedroom-b", "fact": "asleep in bedroom B"},
        ],
        "rooms": [{"room": room, "access": access, "present": [{"id": "npc:10", "name": "Miguel Ortega"}, {"id": "npc:14", "name": "Marisol Vega"}]}]}}


def test_directive_names_the_room_of_a_named_houseguest():
    d = chat_helpers._house_search_directive(_search(), "Look for Miguel. Where is he?")
    assert "HOUSE SEARCH" in d
    assert "Miguel Ortega: bedroom A, open - the player can walk in" in d
    assert "Jett Wooten" not in d.split("Asleep right now")[0]  # only the named houseguest's line
    assert "Asleep right now: 1 houseguest" not in d and "Asleep right now: 11 houseguests" in d
    assert "never say they are nowhere" in d


def test_directive_with_no_name_lists_every_awake_houseguest_and_the_closed_door():
    d = chat_helpers._house_search_directive(_search("HOH room, door closed", "closed", "hoh-room"), "Check every room")
    assert "Miguel Ortega: HOH room, door closed" in d and "Marisol Vega: HOH room, door closed" in d
    assert "Jett Wooten: living room, open" in d
    assert "Sleepy One: " not in d.split("Asleep right now")[0]  # sleepers are summarised, not listed as awake
    assert "hoh room (door closed): Miguel Ortega, Marisol Vega" in d


def test_directive_is_vault_free_and_fails_open():
    d = chat_helpers._house_search_directive(_search(), "where is everybody")
    import re
    assert not re.search(r"secret|vault|soul|suspect|affinity|trust|plotting|scheming", d.split("VOICE THIS")[0], re.I)
    for bad in (None, {}, {"room": "x"}, {"search": {}}, {"search": {"houseguests": []}}, "x"):
        assert chat_helpers._house_search_directive(bad, "where is Miguel") is None


def _wa(asleep=11, rooms=None):
    nearby = []
    for r, n in (rooms or {"living-room": 1, "kitchen": 0, "dining-room": 0}).items():
        nearby.append({"room": r, "present": [{"id": f"n:{r}{i}", "name": "Jett Wooten"} for i in range(n)]})
    return {"room": "backyard", "present": [{"id": "npc:15", "name": "Janelle"}], "nearby": nearby, "counts": {"room": 2, "others": 1, "house": 16, "asleep": asleep}}


def _fake(monkeypatch, wa):
    async def w(user=None, search=False):
        if isinstance(wa, Exception):
            raise wa
        return wa

    async def p(user=None):
        return None
    monkeypatch.setattr(orwell_engine, "whereabouts", w)
    monkeypatch.setattr(orwell_engine, "premiere_intros", p)


def _emit(s):
    return _run(chat_helpers.screen_streamed_headcount(_USER, s))


def test_wrong_asleep_count_is_caught(monkeypatch):
    _fake(monkeypatch, _wa())
    assert _emit("Twelve of them asleep in their beds.") is False
    assert "11 houseguests" in chat_helpers._DESYNC_REGROUND[_USER]
    assert _emit("There are thirteen asleep upstairs.") is False
    assert _emit("Eleven asleep in their beds.") is True
    assert _emit("Two of them asleep in bedroom B.") is True  # a subgroup, not a claim about the house


def test_empty_claim_about_an_occupied_visible_room_is_caught(monkeypatch):
    _fake(monkeypatch, _wa())
    assert _emit("The living room is empty.") is False
    assert "RE-GROUND ON THE ROOMS" in chat_helpers._DESYNC_REGROUND[_USER]
    chat_helpers._DESYNC_REGROUND.pop(_USER, None)
    assert _emit("The kitchen, the living room, the dining room — all of them empty.") is False
    assert _emit("An empty living room greets you.") is False
    assert _emit("The kitchen is empty, but the living room has Jett in it.") is True  # the empty one really is
    assert _emit("The kitchen is empty.") is True and _emit("The dining room is deserted.") is True
    assert _emit("Marisol's hands are empty.") is True  # no room named
    assert _emit("The living room is empty-handed of excuses.") is True


def test_wall_drops_only_the_wrong_sentences(monkeypatch):
    _fake(monkeypatch, _wa())
    out = _run(chat_helpers.screen_headcount_wall(_USER, "The kitchen is quiet. The living room is empty. Twelve of them asleep. The HOH room's door is shut."))
    assert out == "The kitchen is quiet. The HOH room's door is shut."


def test_fails_open_with_no_asleep_count_or_no_read(monkeypatch):
    _fake(monkeypatch, {"room": "backyard", "present": [], "nearby": [], "counts": {"room": 1, "others": 0, "house": 16}})
    assert _emit("Twelve of them asleep.") is True  # clock off: no asleep count, nothing to contradict
    _fake(monkeypatch, RuntimeError("down"))
    assert _emit("The living room is empty.") is True


def test_the_barrier_directive_states_the_asleep_count():
    out = chat_helpers._whereabouts_barrier_directive(_wa(asleep=11))
    assert "Asleep right now: 11 houseguests" in out
    assert "Asleep right now" not in chat_helpers._whereabouts_barrier_directive({**_wa(), "counts": {"room": 2, "others": 1, "house": 16}})


def test_directive_tells_the_narrator_an_unarrived_houseguest_is_not_behind_a_door():
    sv = _search()
    sv["search"]["houseguests"].append({"id": "npc:14", "name": "Marisol Ashwood", "status": "arriving", "fact": "has not walked into the house yet (still to enter at the premiere)"})
    d = chat_helpers._house_search_directive(sv, "where is Marisol?")
    assert "Marisol Ashwood: has not walked into the house yet" in d
    assert "never place them in a room or behind a door" in d

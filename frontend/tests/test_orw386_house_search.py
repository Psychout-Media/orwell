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


# --- ORW-462 (Kevin 2026-11-15): the search never sees through a door, and a named houseguest is always found ---

def _closed_search():
    return {"room": "backyard", "present": [], "nearby": [], "search": {"asleepCount": 0, "rooms": [], "houseguests": [
        {"id": "npc:10", "name": "Miguel Ortega", "status": "unseen", "fact": "not in view; behind a door in the house (the player can open doors and look)"},
        {"id": "npc:14", "name": "Marisol Vega", "status": "lead", "room": "bedroom-a", "fact": "last seen heading into the bedroom A a moment ago - not confirmed: the player can go and look, or ask around"},
        {"id": "npc:11", "name": "Jett Wooten", "status": "unknown", "fact": "nobody here knows where they are: the player can look around the house or ask around"},
    ]}}


def test_search_target_is_the_named_houseguest_from_the_roster():
    gs = {"player": {"id": "player"}, "house": [{"id": "player", "name": "Pat Lee"}, {"id": "npc:10", "name": "Miguel Ortega"}, {"id": "npc:11", "name": "Jett Wooten"}]}
    assert chat_helpers._search_target("Look for Miguel. Where is he?", gs) == "Miguel Ortega"
    assert chat_helpers._search_target("where is jett wooten", gs) == "Jett Wooten"  # a full name matches in any case
    assert chat_helpers._search_target("Check every room", gs) is None
    assert chat_helpers._search_target("Where is Pat?", gs) is None  # the player is not searched for
    assert chat_helpers._search_target(None, gs) is None and chat_helpers._search_target("Where is Miguel?", None) is None


def test_directive_never_names_a_room_for_an_unseen_houseguest_and_voices_leads_and_unknowns_honestly():
    d = chat_helpers._house_search_directive(_closed_search(), "Where is everybody")
    assert "Miguel Ortega: not in view" in d
    assert "bedroom" not in d.split("Miguel Ortega: not in view")[1].split("\n")[0]
    assert "Marisol Vega: last seen heading into the bedroom A a moment ago - not confirmed" in d
    assert "Jett Wooten: nobody here knows where they are" in d
    voice = d.split("VOICE THIS")[1]
    assert "not omniscient" in voice and "never confirms where someone is" in voice
    assert "as a lead" in voice and "nobody here knows" in voice and "never name the diary room or the HOH room" in voice
    assert "Every other room has no awake houseguest" not in d  # out-of-view rooms are unknown, never "empty"


def test_engine_wrapper_sends_looking_for_only_when_given(monkeypatch):
    seen = []

    async def call(name, args, user=None):
        seen.append((name, args))
        return None
    monkeypatch.setattr(orwell_engine, "_call", call)
    _run(orwell_engine.whereabouts(user=_USER, search=True))
    _run(orwell_engine.whereabouts(user=_USER, search=True, looking_for="Miguel Ortega"))
    _run(orwell_engine.whereabouts(user=_USER))
    assert seen == [("whereabouts", {"search": True}), ("whereabouts", {"search": True, "lookingFor": "Miguel Ortega"}), ("whereabouts", {})]


def _roster(*names, evicted=()):
    return {"player": {"id": "player"}, "house": [{"id": "player", "name": "Pat Lee", "status": "active"}] + [
        {"id": f"npc:{i}", "name": n, "status": "evicted" if n in evicted else "active"} for i, n in enumerate(names, 1)]}


def test_search_target_full_name_beats_a_first_name_match_earlier_in_the_roster():
    gs = _roster("Alex Smith", "Alex Jones", "Miguel Ortega")
    assert chat_helpers._search_target("Where is Alex Jones?", gs) == "Alex Jones"
    assert chat_helpers._search_target("Where is Alex Smith?", gs) == "Alex Smith"


def test_search_target_a_first_name_shared_by_two_active_houseguests_names_nobody():
    gs = _roster("Alex Smith", "Alex Jones", "Miguel Ortega")
    assert chat_helpers._search_target("Where is Alex?", gs) is None
    assert chat_helpers._search_target("Where is Alex?", _roster("Alex Smith", "Alex Jones", evicted=("Alex Jones",))) == "Alex Smith"


def test_search_target_ignores_lowercase_words_that_are_first_names():
    gs = _roster("Will Baker", "Miguel Ortega")
    assert chat_helpers._search_target("where is Miguel, will you check", gs) == "Miguel Ortega"
    assert chat_helpers._search_target("where is will", gs) is None
    assert chat_helpers._search_target("where is miguel?", gs) == "Miguel Ortega"  # an ordinary first name matches in any case (review of #2804)
    assert chat_helpers._search_target("WHERE IS MIGUEL", gs) == "Miguel Ortega"
    assert chat_helpers._search_target("Where is Will?", gs) == "Will Baker"


def test_search_target_is_the_earliest_named_in_the_message_not_the_roster_order():
    gs = _roster("Miguel Ortega", "Ana Ruiz")
    assert chat_helpers._search_target("where are Ana and Miguel?", gs) == "Ana Ruiz"
    assert chat_helpers._search_target("where are Miguel Ortega and Ana?", gs) == "Miguel Ortega"


def test_search_target_skips_evicted_houseguests():
    gs = _roster("Miguel Ortega", "Ana Ruiz", evicted=("Miguel Ortega",))
    assert chat_helpers._search_target("Where is Miguel Ortega?", gs) is None
    assert chat_helpers._search_target("where are Miguel and Ana", gs) == "Ana Ruiz"


def test_search_target_ordinary_word_first_names_need_a_capital():
    gs = _roster("Wade Cole", "Penny Marsh", "Willow Reed", "Violet Ames", "Trinity Cho", "Griffin Lee")
    for text in ("how do I wade through this crowd", "a penny for your thoughts", "the willow by the gate", "a violet dress", "the trinity of rules", "a griffin on the crest"):
        assert chat_helpers._search_target(text, gs) is None, text
    assert chat_helpers._search_target("Where is Wade?", gs) == "Wade Cole"
    assert chat_helpers._search_target("where is Penny", gs) == "Penny Marsh"

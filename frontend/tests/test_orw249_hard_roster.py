"""ORW-249 slice 1 (Ryne 2026-11-07: "who is in the room with me on the widget is different than who's in with me in the chat"): prod logs show the narrator writing absent houseguests into nearly every scene
(6 "auto-record: dropped off-scene withIds" in 5 messages; 5 presence-wall drops in 30 minutes). The location directive said "voice only the people who are here OR WHO PLAUSIBLY WALK IN FROM AN ADJACENT ROOM" - an
open door the narrator used every turn. The per-turn roster is now HARD: only these people are here; nobody else speaks, acts, reacts or is described as present; arrivals are the game's to bring. Roles only."""
import importlib

ch = importlib.import_module("routes.chat_helpers")

WA = {
    "room": "kitchen",
    "present": [{"id": "npc:1", "name": "Houseguest One"}, {"id": "npc:2", "name": "Houseguest Two"}],
    "nearby": [{"room": "backyard", "present": [{"id": "npc:3", "name": "Houseguest Three"}]}],
}


def test_the_roster_is_stated_as_the_only_people_here():
    out = ch._whereabouts_barrier_directive(WA)
    low = out.lower()
    assert "hard roster" in low
    assert "only people in the room" in low or "only people here" in low
    assert "Houseguest One" in out and "Houseguest Two" in out


def test_nobody_off_the_roster_may_speak_act_or_be_described_present():
    low = ch._whereabouts_barrier_directive(WA).lower()
    assert "nobody else" in low
    for verb in ("speaks", "acts", "reacts"):
        assert verb in low, f"the roster rule must name '{verb}'"
    assert "described as present" in low


def test_the_walk_in_loophole_is_closed_but_leaving_is_still_allowed():
    low = ch._whereabouts_barrier_directive(WA).lower()
    assert "plausibly walk in" not in low, "the old loophole that let the narrator bring adjacent people in every turn"
    assert "walks in" in low and "arrivals" in low, "arrivals are explicitly the game's to bring"
    assert "may leave" in low or "may move" in low, "people on the roster may still leave - the house stays dynamic"


def test_an_empty_room_says_the_player_is_alone_not_nobody_to_voice():
    out = ch._whereabouts_barrier_directive({"room": "hoh-room", "present": [], "nearby": []})
    low = out.lower()
    assert "alone" in low and "nobody else" in low


def test_adjacent_room_people_are_named_as_staying_in_their_rooms():
    low = ch._whereabouts_barrier_directive(WA).lower()
    assert "backyard" in low and "houseguest three" in low
    assert "stay" in low


# ── ORW-311: the houseguests the engine says have TURNED IN are in their beds - never voiced awake ──────────────────────────────────────────────────────
ASLEEP = [{"id": "npc:1", "name": "Houseguest Four"}, {"id": "npc:2", "name": "Houseguest Five"}]


def test_asleep_houseguests_are_named_and_barred_from_the_scene():
    out = ch._whereabouts_barrier_directive(WA, ASLEEP)
    assert "TURNED IN FOR THE NIGHT" in out and "Houseguest Four, Houseguest Five" in out
    low = out.lower()
    assert "asleep in their beds" in low and "do not write a scene" in low and "only be mentioned" in low


def test_no_sleepers_no_line_and_the_directive_is_byte_identical():
    assert ch._whereabouts_barrier_directive(WA) == ch._whereabouts_barrier_directive(WA, None) == ch._whereabouts_barrier_directive(WA, [])
    assert "TURNED IN" not in ch._whereabouts_barrier_directive(WA)


def test_the_asleep_list_rides_names_only_and_the_call_site_passes_it():
    out = ch._whereabouts_barrier_directive(WA, [{"id": "npc:1", "name": "Houseguest Four", "secret": "x"}, {"name": ""}, "junk"])
    assert "npc:1" not in out and "secret" not in out.lower().replace("secrets", "")
    src = open(ch.__file__, encoding="utf-8").read()
    assert '_whereabouts_barrier_directive(game_state.get("whereabouts"), game_state.get("asleep"))' in src

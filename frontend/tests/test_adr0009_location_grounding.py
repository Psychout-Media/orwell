"""ADR 0009 (D3 Part A) — the LOCATION grounding barrier (a chat↔board DESYNC class).

Root cause #1 of the chat<->board location desync: room occupancy is grounded by PROMPT TEXT ONLY,
and the model overrides it from its own conversation memory (the same LW9 pattern the comp-round
clamp exists for). The fix surfaces the engine's `whereabouts` as an ENFORCEABLE fact — the current
room + who is present + the adjacent rooms — and pins three hard rules that keep the prose foldable
into the board with NO visible historic conflict (the PO's overriding constraint): an evicted
houseguest is GONE, rooms are limited to the floor plan, and a person is in exactly ONE place at a
time. It DELIBERATELY permits narrated movement (the engine records it, D2) so the house stays
dynamic — only the impossible is forbidden.
"""

import importlib

chat_helpers = importlib.import_module("routes.chat_helpers")


# ── helper unit tests ──────────────────────────────────────────────────── #

def test_no_whereabouts_returns_none():
    assert chat_helpers._whereabouts_barrier_directive(None) is None
    assert chat_helpers._whereabouts_barrier_directive({}) is None
    # A whereabouts with no room (player out of the house / unseeded presence) ⇒ no directive.
    assert chat_helpers._whereabouts_barrier_directive({"room": ""}) is None
    assert chat_helpers._whereabouts_barrier_directive({"present": []}) is None
    # Non-dict shapes must also fail safe.
    assert chat_helpers._whereabouts_barrier_directive("kitchen") is None
    assert chat_helpers._whereabouts_barrier_directive(0) is None


def test_directive_states_the_room_and_who_is_present():
    wa = {
        "room": "kitchen",
        "present": [{"id": "npc:1", "name": "Houseguest One"}, {"id": "npc:2", "name": "Houseguest Two"}],
        "nearby": [],
    }
    out = chat_helpers._whereabouts_barrier_directive(wa)
    assert out and isinstance(out, str)
    assert "kitchen" in out
    assert "Houseguest One" in out and "Houseguest Two" in out
    # It is grounded against the engine as the source of truth.
    assert "source of truth" in out.lower()


def test_directive_summarizes_adjacent_rooms_with_occupants():
    wa = {
        "room": "living-room",
        "present": [],
        "nearby": [
            {"room": "kitchen", "present": [{"id": "npc:3", "name": "Houseguest Three"}]},
            {"room": "backyard", "present": []},
        ],
    }
    out = chat_helpers._whereabouts_barrier_directive(wa)
    assert out
    assert "kitchen" in out and "Houseguest Three" in out
    # An empty adjacent room is labelled, not omitted (so the model can't quietly fill it).
    assert "backyard" in out and "empty" in out.lower()


def test_directive_pins_the_three_impossibility_rules():
    wa = {"room": "kitchen", "present": [], "nearby": []}
    out = chat_helpers._whereabouts_barrier_directive(wa)
    low = out.lower()
    # (1) evicted houseguests are gone
    assert "evicted" in low
    # (2) no invented rooms
    assert "invent a room" in low or "not part of the house" in low
    # (3) one place at a time
    assert "one place" in low


def test_directive_permits_narrated_movement_so_the_house_stays_dynamic():
    # The hard-fold design ALLOWS movement (the engine records it); only the impossible is forbidden.
    # A directive that forbade all movement would freeze the house — assert it explicitly permits it.
    wa = {"room": "kitchen", "present": [], "nearby": []}
    out = chat_helpers._whereabouts_barrier_directive(wa)
    low = out.lower()
    assert "may move" in low or "move between rooms" in low


def test_empty_room_is_still_grounded():
    # The player alone in a room is a valid scene — the directive still pins the room + the rules so
    # the model doesn't invent company (the anti-"empty room" wording exists because this happened).
    wa = {"room": "hoh-room", "present": [], "nearby": []}
    out = chat_helpers._whereabouts_barrier_directive(wa)
    assert out and "hoh-room" in out
    assert "no other houseguest" in out.lower()


def test_malformed_present_entries_are_skipped_not_crashed():
    wa = {
        "room": "kitchen",
        "present": [None, {"id": "npc:1"}, {"name": ""}, {"id": "npc:2", "name": "Real Name"}, "junk"],
        "nearby": ["junk", {"room": ""}, {"room": "backyard", "present": [None, {"name": "Adj Name"}]}],
    }
    out = chat_helpers._whereabouts_barrier_directive(wa)
    assert out
    assert "Real Name" in out and "Adj Name" in out  # only the well-formed names survive


# ── source-pin: the wiring stays in apply_game_framing ──────────────────── #

def test_framing_appends_the_location_barrier_fail_open():
    import os
    src = open(
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "routes", "chat_helpers.py"),
        encoding="utf-8",
    ).read()
    # apply_game_framing calls the location helper and appends it to gm_prompt.
    assert "_whereabouts_barrier_directive(" in src
    # It reads the whereabouts off the SAME game_state snapshot (no extra round-trip; supports D1).
    # deliberate re-pin (ORW-311): the call also passes the engine's public `asleep` list so the narrator is barred from voicing houseguests who have turned in.
    assert '_whereabouts_barrier_directive(game_state.get("whereabouts"), game_state.get("asleep"), game_state.get("playerMove"))' in src
    # The fetch is wrapped in try/except (fail-open) and warns on failure.
    loc_call = src.index('_loc = _whereabouts_barrier_directive(')
    # the FIRST `except Exception` after the call is this try's handler, and it is the one that logs the skip (a precise binding, not a character window)
    exc = src.index("except Exception", loc_call)
    assert "location grounding skipped" in src[exc:exc + 200]
    # It runs after gm_prompt is built and before the prompt is prepended to the preface.
    fallback = src.index('gm_prompt = (mp or {}).get("systemPrompt") or FALLBACK_GM_PROMPT')
    prepend = src.index('preface[0]["content"] = gm_prompt + "\\n\\n"')
    assert fallback < loc_call < prepend
    # It runs AFTER the pending barrier (both are location/decision grounding; order is intentional).
    pending_call = src.index("_barrier = _pending_barrier_directive(")
    assert pending_call < loc_call


# --- ORW-478: the player's own move reaches the briefing, and a houseguest left off the roster does not just vanish ---

def _wa(room="kitchen", present=(), turns=0, **extra):
    return {"room": room, "present": [{"id": f"npc:{i}", "name": n} for i, n in enumerate(present, 1)], "nearby": [], "turnsHere": turns, **extra}


def test_a_player_move_this_turn_is_stated_in_the_directive():
    d = chat_helpers._whereabouts_barrier_directive(_wa("kitchen", ["Role A"]), None, {"from": "living-room", "to": "kitchen"})
    assert "THE PLAYER JUST MOVED: from the living room to the kitchen" in d
    assert "Open this turn's scene in the kitchen" in d and "never in the living room" in d


def test_a_move_that_does_not_end_in_this_room_is_never_voiced():
    # defence in depth: the engine withholds a move from any later turn's state, but a move to another room is never voiced here either
    assert "JUST MOVED" not in chat_helpers._whereabouts_barrier_directive(_wa("kitchen", ["Role A"]), None, {"from": "kitchen", "to": "living-room"})


def test_no_move_line_without_a_move_or_for_a_refused_or_same_room_move():
    for mv in (None, {}, {"refused": True, "reason": "x"}, {"from": "kitchen", "to": "kitchen"}, "kitchen"):
        assert "JUST MOVED" not in chat_helpers._whereabouts_barrier_directive(_wa("kitchen", ["Role A"]), None, mv)


def test_the_vanish_line_comes_only_on_a_move_or_a_departure_and_never_over_the_asleep_rule():
    quiet = chat_helpers._whereabouts_barrier_directive(_wa("bedroom-a", [], turns=4))
    assert "do not make them vanish" not in quiet  # an ordinary alone turn: no extra instruction
    after_move = chat_helpers._whereabouts_barrier_directive(_wa("bedroom-a", [], turns=1), None, {"from": "kitchen", "to": "bedroom-a"})
    assert "do not make them vanish" in after_move and "unless they are on the asleep list: then only mentioned" in after_move
    left = chat_helpers._whereabouts_barrier_directive(_wa("kitchen", [], turns=2, sinceSend={"arrived": [], "departed": ["Role A"]}))
    assert "do not make them vanish" in left
    assert "do not make them vanish" not in chat_helpers._whereabouts_barrier_directive(_wa("kitchen", ["Role B"], turns=0, sinceSend={"departed": ["Role A"]}))


def test_orw481_adjacent_room_alias_frames_elsewhere():
    """ORW-481 (review 4502876781): 'the yard' is the adjacent backyard, so the sentence frames another room."""
    from routes.chat_helpers import _sentence_frames_elsewhere
    assert _sentence_frames_elsewhere("Somebody laughs out in the yard.", {"adjacent_rooms": ["backyard"]})
    assert not _sentence_frames_elsewhere("Somebody laughs in the kitchen.", {"adjacent_rooms": ["backyard"]})

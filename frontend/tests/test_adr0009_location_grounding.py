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
    assert '_whereabouts_barrier_directive(game_state.get("whereabouts"), game_state.get("asleep"))' in src
    # The fetch is wrapped in try/except (fail-open) and warns on failure.
    loc_call = src.index('_loc = _whereabouts_barrier_directive(')
    assert "except Exception" in src[loc_call:loc_call + 400]
    assert "location grounding skipped" in src
    # It runs after gm_prompt is built and before the prompt is prepended to the preface.
    fallback = src.index('gm_prompt = (mp or {}).get("systemPrompt") or FALLBACK_GM_PROMPT')
    prepend = src.index('preface[0]["content"] = gm_prompt + "\\n\\n"')
    assert fallback < loc_call < prepend
    # It runs AFTER the pending barrier (both are location/decision grounding; order is intentional).
    pending_call = src.index("_barrier = _pending_barrier_directive(")
    assert pending_call < loc_call

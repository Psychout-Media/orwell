"""Issue #1726 (A2) — the STRUCTURAL presence guard (the "Guard" half of the issue's 3-part spec;
the "Bind" half — the terminal whereabouts occupancy pin — is a separate change to the narrator
prompt).

A live A/B on `z-ai/glm-4.7` (reasoning-off) found the existing next-turn-only nudge
(`_presence_desync_directive` / `record_post_turn_presence_check`, feature 0076) insufficient on its
own: the terminal binding pin alone only cut the phantom-placement failure rate 5/6 -> 3/6, never to
zero (issue #1726 comment, 2026-07-21). "Location does NOT bind on wording alone" — a STRUCTURAL,
SAME-TURN guard is required, mirroring `screen_knowledge_wall`'s DROP posture rather than 0076's
gentler re-ground-only posture.

This module tests the two new pieces:
  (a) `screen_presence_wall` — drops a sentence that stages an off-scene/evicted houseguest as
      present, BEFORE the text reaches the player (same-turn, sibling to `screen_knowledge_wall`).
  (b) `_presence_omission_directive` — detects the inverse (PARITY-8): the engine places houseguests
      in the player's room, but narration never surfaces any of them at all ("room population never
      updates").

Roles only: houseguest display names are throwaway role words, exercising the regexes exactly as the
sibling 0076 / knowledge-wall guard tests do; no name carries test intent.
"""

import asyncio
import importlib
import re

import pytest

chat_helpers = importlib.import_module("routes.chat_helpers")

_USER = "u-presence-wall"


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _state(room, present, nearby=None, house=None):
    return {
        "whereabouts": {
            "room": room,
            "present": [{"id": f"npc:{n}", "name": n} for n in present],
            "nearby": [{"room": r, "present": [{"id": f"npc:{n}", "name": n} for n in ps]}
                       for r, ps in (nearby or {}).items()],
        },
        "house": house or [],
    }


def _house(active=(), evicted=()):
    return ([{"name": n, "status": "active"} for n in active]
            + [{"name": n, "status": "evicted"} for n in evicted])


def _async(value):
    async def _c(*a, **k):
        return value
    return _c()


@pytest.fixture(autouse=True)
def _clean_state():
    dkey = chat_helpers._desync_key(_USER)
    for key in (dkey, None, "default"):
        chat_helpers._LAST_BEAT_SIG.pop(key, None)
        chat_helpers._DESYNC_REGROUND.pop(key, None)
    yield
    for key in (dkey, None, "default"):
        chat_helpers._LAST_BEAT_SIG.pop(key, None)
        chat_helpers._DESYNC_REGROUND.pop(key, None)


# ── part (a): screen_presence_wall DROPS a phantom placement, same-turn ──────────────────────── #

def test_scan_drops_the_sentence_staging_an_offscene_houseguest(monkeypatch):
    from src import orwell_engine
    state = _state(
        "backyard", present=["An Ally"],
        house=_house(active=["An Ally", "A Schemer"]),
    )
    monkeypatch.setattr(orwell_engine, "get_game_state", lambda user=None: _async(state))
    transcript = (
        "The backyard was quiet under the string lights. "
        'A Schemer leans against the fence and mutters, "nobody suspects us yet." '
        "You kept your face still and changed the subject."
    )
    out = _run(chat_helpers.screen_presence_wall(_USER, transcript))
    assert "A Schemer" not in out               # the phantom placement is gone
    assert "The backyard was quiet" in out       # ordinary prose survives
    assert "changed the subject" in out
    # A next-turn re-ground is stashed after a drop.
    assert chat_helpers._DESYNC_REGROUND.get(chat_helpers._desync_key(_USER))


def test_scan_drops_the_sentence_staging_an_evicted_houseguest(monkeypatch):
    from src import orwell_engine
    state = _state(
        "living-room", present=["An Ally"],
        house=_house(active=["An Ally"], evicted=["A Ghost"]),
    )
    monkeypatch.setattr(orwell_engine, "get_game_state", lambda user=None: _async(state))
    transcript = 'A Ghost smirks from the couch, "did you miss me?" An Ally rolls her eyes.'
    out = _run(chat_helpers.screen_presence_wall(_USER, transcript))
    assert "did you miss me" not in out          # the evicted houseguest's staged line is gone
    assert "An Ally rolls her eyes" in out


def test_scan_drops_the_sentence_staging_a_turned_in_houseguest(monkeypatch):
    # ADR 0006 / 0076 presence wall: with the day clock on, a houseguest who has turned in is OFF the
    # floor. The engine's whereabouts no longer lists them in the room (nor nearby), and getGameState
    # names them in `asleep` while they stay "active" on the roster. Narration that stages them as
    # present and acting in the room is a phantom placement and must be dropped, same-turn.
    from src import orwell_engine
    state = _state(
        "living-room", present=["An Ally"],
        house=_house(active=["An Ally", "A Sleeper"]),
    )
    state["timeOfDay"] = "late-night"
    state["asleep"] = [{"id": "npc:2", "name": "A Sleeper"}]
    monkeypatch.setattr(orwell_engine, "get_game_state", lambda user=None: _async(state))
    transcript = (
        "The living room had gone quiet. "
        'A Sleeper sits on the couch beside you and whispers, "we should talk about the vote." '
        "An Ally rolls her eyes."
    )
    out = _run(chat_helpers.screen_presence_wall(_USER, transcript))
    assert "A Sleeper" not in out                 # the turned-in houseguest is not staged in the room
    assert "we should talk about the vote" not in out
    assert "The living room had gone quiet." in out   # ordinary prose survives
    assert "An Ally rolls her eyes." in out           # the awake one in the room is untouched
    # A next-turn re-ground is stashed after a drop.
    assert chat_helpers._DESYNC_REGROUND.get(chat_helpers._desync_key(_USER))


def test_scan_passes_clean_narration_through_verbatim(monkeypatch):
    from src import orwell_engine
    state = _state(
        "kitchen", present=["An Ally", "A Neighbor"],
        house=_house(active=["An Ally", "A Neighbor", "A Schemer"]),
    )
    monkeypatch.setattr(orwell_engine, "get_game_state", lambda user=None: _async(state))
    clean = 'An Ally grins and says, "welcome to my kitchen." You both laugh about it.'
    out = _run(chat_helpers.screen_presence_wall(_USER, clean))
    assert out == clean  # byte-identical: nobody off-scene/evicted is staged


def test_scan_is_a_noop_when_nothing_is_offscene_or_evicted(monkeypatch):
    from src import orwell_engine
    # The whole (small) house is in view — nobody to guard against.
    state = _state("kitchen", present=["An Ally", "A Neighbor"],
                    house=_house(active=["An Ally", "A Neighbor"]))
    monkeypatch.setattr(orwell_engine, "get_game_state", lambda user=None: _async(state))
    text = 'A Neighbor says, "pass the salt."'
    out = _run(chat_helpers.screen_presence_wall(_USER, text))
    assert out == text


def test_scan_is_a_noop_without_a_live_scene(monkeypatch):
    from src import orwell_engine
    # Pre-game / player out of the house: no usable whereabouts.
    monkeypatch.setattr(orwell_engine, "get_game_state", lambda user=None: _async({"whereabouts": None}))
    text = 'A Schemer says, "hello?"'
    out = _run(chat_helpers.screen_presence_wall(_USER, text))
    assert out == text


def test_scan_is_fail_open_on_an_engine_read_error(monkeypatch):
    from src import orwell_engine

    async def _boom(user=None):
        raise RuntimeError("engine unreachable")

    monkeypatch.setattr(orwell_engine, "get_game_state", _boom)
    text = 'A Schemer says, "hello?"'
    out = _run(chat_helpers.screen_presence_wall(_USER, text))
    assert out == text  # never hold narration on a read hiccup


def test_scan_does_not_flag_a_nearby_houseguest(monkeypatch):
    from src import orwell_engine
    state = _state(
        "living-room", present=["An Ally"], nearby={"kitchen": ["A Neighbor"]},
        house=_house(active=["An Ally", "A Neighbor"]),
    )
    monkeypatch.setattr(orwell_engine, "get_game_state", lambda user=None: _async(state))
    text = 'A Neighbor calls out from the kitchen, "dinner in five!"'
    out = _run(chat_helpers.screen_presence_wall(_USER, text))
    assert out == text  # a nearby (glimpsed/overheard) houseguest is legitimate, never dropped


def test_scan_only_drops_the_offending_sentence_not_the_whole_scene(monkeypatch):
    from src import orwell_engine
    state = _state("backyard", present=["An Ally"], house=_house(active=["An Ally", "A Schemer"]))
    monkeypatch.setattr(orwell_engine, "get_game_state", lambda user=None: _async(state))
    transcript = (
        "An Ally settles into the lounge chair. "
        'A Schemer steps in and announces, "I run this house." '
        "The sprinklers click on in the distance."
    )
    out = _run(chat_helpers.screen_presence_wall(_USER, transcript))
    assert "An Ally settles into the lounge chair." in out
    assert "I run this house" not in out
    assert "The sprinklers click on in the distance." in out


def test_scan_fires_single_tenant_with_owner_none(monkeypatch):
    # Under AUTH_ENABLED=false the chat route runs with owner=None (NAR-1 safety).
    from src import orwell_engine
    state = _state("backyard", present=["An Ally"], house=_house(active=["An Ally", "A Schemer"]))
    monkeypatch.setattr(orwell_engine, "get_game_state", lambda user=None: _async(state))
    dkey = chat_helpers._desync_key(None)
    try:
        text = 'A Schemer leans in and says, "you can trust me." You nod slowly.'
        out = _run(chat_helpers.screen_presence_wall(None, text))
        assert "you can trust me" not in out
        assert "You nod slowly." in out
    finally:
        chat_helpers._DESYNC_REGROUND.pop(dkey, None)


# ── part (b): the inverse — an engine-present houseguest the narration omitted entirely ─────── #

def test_omission_flags_when_no_present_houseguest_is_mentioned_at_all():
    # NOTE: the transcript deliberately avoids a bare "a"/"an" token — with the guard's
    # case-insensitive first-name match (CodeRabbit #1746), a stray indefinite article would
    # otherwise collide with the placeholder role "A Neighbor"'s single-letter first name.
    facts = {"room": "kitchen", "in_view": {"An Ally", "A Neighbor"},
             "room_present": {"An Ally", "A Neighbor"}, "active_offscene": set(), "evicted": set()}
    directive = chat_helpers._presence_omission_directive(
        "You wander into the empty-feeling kitchen and pour water alone, saying nothing.", facts)
    assert directive is not None
    assert "An Ally" in directive and "A Neighbor" in directive
    assert "never mentioned" in directive


def test_omission_does_not_flag_when_at_least_one_present_npc_appears():
    facts = {"room": "kitchen", "in_view": {"An Ally", "A Neighbor"},
             "room_present": {"An Ally", "A Neighbor"}, "active_offscene": set(), "evicted": set()}
    # Only ONE of the two present houseguests gets a line — legitimate spotlighting, not a swap.
    directive = chat_helpers._presence_omission_directive(
        'An Ally looks up from the counter and says, "morning."', facts)
    assert directive is None


def test_omission_is_none_when_nobody_is_present_in_the_room():
    facts = {"room": "kitchen", "in_view": set(), "room_present": set(),
             "active_offscene": {"A Schemer"}, "evicted": set()}
    assert chat_helpers._presence_omission_directive("You eat cereal alone.", facts) is None


def test_omission_bare_mention_counts_as_surfaced_not_only_staging():
    # A bare mention (no staging verb) is enough to prove the narration acknowledged them.
    facts = {"room": "kitchen", "in_view": {"An Ally"},
             "room_present": {"An Ally"}, "active_offscene": set(), "evicted": set()}
    directive = chat_helpers._presence_omission_directive(
        "You glance at An Ally across the room but say nothing.", facts)
    assert directive is None


def test_omission_still_fires_when_only_an_ambiguous_first_name_is_mentioned():
    # Greptile P1 (#1746): two roster members share the first name "Alex" — one PRESENT (Alex Kim),
    # one off-scene (Alex Diaz). Narration mentions only the bare, ambiguous first name "Alex". That
    # must NOT be credited to the present occupant (it could equally mean the off-scene one), so the
    # omission guard must still fire for the real room population — mirroring the same uniqueness bar
    # `_name_staged_unique` / `_presence_desync_directive` already apply on the drop side.
    facts = {"room": "kitchen", "in_view": {"Alex Kim"},
             "room_present": {"Alex Kim"}, "active_offscene": {"Alex Diaz"}, "evicted": set()}
    directive = chat_helpers._presence_omission_directive(
        "You wonder where Alex went as you wash a mug alone in the quiet kitchen.", facts)
    assert directive is not None
    assert "Alex Kim" in directive


def test_omission_does_not_fire_when_the_unique_full_name_is_mentioned():
    # The FULL name is never ambiguous — mentioning "Alex Kim" by full name still surfaces them even
    # though "Alex" alone is shared with the off-scene "Alex Diaz".
    facts = {"room": "kitchen", "in_view": {"Alex Kim"},
             "room_present": {"Alex Kim"}, "active_offscene": {"Alex Diaz"}, "evicted": set()}
    directive = chat_helpers._presence_omission_directive(
        "You spot Alex Kim by the sink and give a small wave.", facts)
    assert directive is None


def test_omission_mention_matches_case_insensitively():
    # CodeRabbit (#1746): `_mentioned_anywhere` must match case-insensitively, mirroring
    # `_stages_in_scene`/`_name_staged_unique` — narration doesn't always render a roster name in its
    # stored casing. A casing mismatch here would wrongly conclude "never mentioned" and fire an
    # unnecessary re-ground (a false omission flag).
    facts = {"room": "kitchen", "in_view": {"An Ally"},
             "room_present": {"An Ally"}, "active_offscene": set(), "evicted": set()}
    directive = chat_helpers._presence_omission_directive(
        "you spot an ally leaning on the counter and nod hello.", facts)  # all-lowercase mention
    assert directive is None  # the differently-cased mention still counts as surfaced


def test_post_turn_check_stashes_the_omission_reground(monkeypatch):
    from src import orwell_engine
    state = _state("kitchen", present=["An Ally", "A Neighbor"],
                    house=_house(active=["An Ally", "A Neighbor"]))
    monkeypatch.setattr(orwell_engine, "get_game_state", lambda user=None: _async(state))
    dkey = chat_helpers._desync_key("u-omit")
    chat_helpers._LAST_BEAT_SIG["u-omit"] = {"room": "kitchen"}  # same room — not a move turn
    chat_helpers._DESYNC_REGROUND.pop(dkey, None)
    try:
        _run(chat_helpers.record_post_turn_presence_check(
            "u-omit", "You stand alone by the counter, lost in thought."))
        directive = chat_helpers._DESYNC_REGROUND.get(dkey)
        assert directive and "SURFACE WHO IS ACTUALLY HERE" in directive
    finally:
        chat_helpers._LAST_BEAT_SIG.pop("u-omit", None)
        chat_helpers._DESYNC_REGROUND.pop(dkey, None)


# ── the agent-loop wrapper is wired and fail-open ────────────────────────────────────────────── #

def test_agent_loop_wrapper_drops_the_phantom_placement(monkeypatch):
    agent_loop = importlib.import_module("src.agent_loop")
    from src import orwell_engine
    state = _state("backyard", present=["An Ally"], house=_house(active=["An Ally", "A Schemer"]))
    monkeypatch.setattr(orwell_engine, "get_game_state", lambda user=None: _async(state))
    text = 'A Schemer whispers, "watch your back." You stay silent.'
    out = _run(agent_loop._presence_wall_guard(text, _USER))
    assert "watch your back" not in out
    assert "You stay silent." in out


def test_agent_loop_wrapper_is_fail_open_on_empty():
    agent_loop = importlib.import_module("src.agent_loop")
    assert _run(agent_loop._presence_wall_guard("", _USER)) == ""


# ── Greptile P1 (#1746): the drop must be durable — mirrored into round_response so it never ──── #
# ── survives into the persisted/reload round text (`cleaned_round` / `round_texts`).           ──── #

def test_mirror_wall_drop_removes_the_dropped_sentence_from_round_response():
    agent_loop = importlib.import_module("src.agent_loop")
    # round_response is the RAW per-round accumulator (may hold text this chunk didn't originate,
    # simulating earlier narration already appended this round).
    round_response = (
        "The backyard was quiet under the string lights. "
        'A Schemer leans against the fence and mutters, "nobody suspects us yet." '
        "You kept your face still and changed the subject."
    )
    before = 'A Schemer leans against the fence and mutters, "nobody suspects us yet." '
    after = ""  # the presence wall dropped the whole (single-sentence) chunk
    mirrored = agent_loop._mirror_wall_drop(round_response, before, after)
    assert "A Schemer" not in mirrored
    assert "nobody suspects us yet" not in mirrored
    assert "The backyard was quiet under the string lights." in mirrored
    assert "You kept your face still and changed the subject." in mirrored


def test_mirror_wall_drop_survives_into_the_persisted_reload_text():
    # Reproduces the exact regression: after the mirror, deriving `cleaned_round` the same way the
    # round-completion path does (`strip_tool_blocks(round_response).strip()`) must NOT resurrect
    # the phantom sentence on a history reload.
    agent_loop = importlib.import_module("src.agent_loop")
    from src.agent_tools import strip_tool_blocks
    round_response = (
        "The backyard was quiet under the string lights. "
        'A Schemer leans against the fence and mutters, "nobody suspects us yet." '
        "You kept your face still and changed the subject."
    )
    before = 'A Schemer leans against the fence and mutters, "nobody suspects us yet." '
    after = ""
    round_response = agent_loop._mirror_wall_drop(round_response, before, after)
    cleaned_round = strip_tool_blocks(round_response).strip()
    assert "A Schemer" not in cleaned_round
    assert "nobody suspects us yet" not in cleaned_round
    assert "The backyard was quiet" in cleaned_round
    assert "changed the subject" in cleaned_round


def test_mirror_wall_drop_only_removes_the_rightmost_occurrence():
    # An earlier, unrelated repeat of identical prose elsewhere in the round must survive — only the
    # dropped chunk's OWN occurrence (the round's most-recently-appended tail) is erased.
    agent_loop = importlib.import_module("src.agent_loop")
    dupe = 'A Schemer grins. '
    round_response = dupe + "Some other narration in between. " + dupe
    mirrored = agent_loop._mirror_wall_drop(round_response, dupe, "")
    assert mirrored.count("A Schemer grins.") == 1
    assert mirrored.startswith("A Schemer grins.")  # the LEADING occurrence survives
    assert "Some other narration in between." in mirrored


def test_mirror_wall_drop_is_a_noop_when_nothing_was_dropped():
    agent_loop = importlib.import_module("src.agent_loop")
    round_response = "An Ally grins and says hello. You wave back."
    same = 'An Ally grins and says hello. You wave back.'
    mirrored = agent_loop._mirror_wall_drop(round_response, same, same)
    assert mirrored == round_response


def test_mirror_wall_drop_partial_sentence_removal_keeps_the_rest():
    # Only ONE of two sentences in the chunk is dropped — the survivor stays, in order. `after` is
    # built the SAME way `screen_knowledge_wall`/`screen_presence_wall` build it — split on the
    # identical sentence boundary and rejoin the kept parts verbatim (including whatever leading
    # whitespace that split left attached) — never a hand-trimmed string, which would misrepresent
    # what the real guards actually emit and desync the two-pointer diff.
    agent_loop = importlib.import_module("src.agent_loop")
    lead = "An Ally settles into the lounge chair. "
    dropped_sentence = 'A Schemer struts in and says, "I run this house." '
    kept_sentence = "The sprinklers click on in the distance."
    round_response = lead + dropped_sentence + kept_sentence
    before = dropped_sentence + kept_sentence
    parts = re.split(r"(?<=[.!?\n])", before)
    after = "".join(p for p in parts if "Schemer" not in p)
    mirrored = agent_loop._mirror_wall_drop(round_response, before, after)
    assert "I run this house" not in mirrored
    assert "An Ally settles into the lounge chair." in mirrored
    assert "The sprinklers click on in the distance." in mirrored

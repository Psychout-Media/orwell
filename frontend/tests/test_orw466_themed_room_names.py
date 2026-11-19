"""ORW-466 (Ryne 2026-11-15: "all rooms in the house to be themed as well"): every room name the front end writes itself uses the season's themed name when the
engine's whereabouts carry `roomNames`, and today's plain wording when they do not. A themed name carries its own article ("the Coral Reef Room", "Main Street"), so it is
never prefixed with "the ". Roles only; no model or engine is called.
"""
import asyncio
import importlib
import json
import os
import shutil
import subprocess
import tempfile

import pytest

ch = importlib.import_module("routes.chat_helpers")
al = importlib.import_module("src.agent_loop")
llm_core = importlib.import_module("src.llm_core")

NAMES = {"kitchen": "the Galley", "bedroom-a": "the Coral Reef Room", "backyard": "Main Street"}


def test_room_ref_themed_and_plain():
    assert ch.room_ref("bedroom-a", NAMES) == "the Coral Reef Room"           # never "the the ..."
    assert ch.room_ref("backyard", NAMES) == "Main Street"                    # an article-less name gets none
    assert ch.room_ref("bedroom-a", NAMES, article=False) == "the Coral Reef Room"
    assert ch.room_ref("living-room", NAMES) == "the living room"             # a room the map does not name: the plain label
    assert ch.room_ref("bedroom-a") == "the bedroom a"
    assert ch.room_ref("bedroom-a", None, article=False, plain="bedroom-a") == "bedroom-a"


def test_location_barrier_uses_the_themed_name_and_is_unchanged_without_one():
    wa = {"room": "bedroom-a", "present": [{"id": "npc:1", "name": "Role A"}], "nearby": [{"room": "kitchen", "present": []}]}
    plain = ch._whereabouts_barrier_directive(wa)
    assert "the player is in the bedroom-a, with: Role A." in plain and "Adjacent rooms right now: kitchen (empty)" in plain
    themed = ch._whereabouts_barrier_directive({**wa, "roomNames": NAMES})
    assert "the player is in the Coral Reef Room, with: Role A." in themed
    assert "Adjacent rooms right now: the Galley (empty)" in themed
    assert "the the" not in themed.lower()


def test_movement_cue_and_wrong_room_reground_use_the_themed_name():
    prev, cur = {"room": "kitchen", "present": ["Role A"]}, {"room": "kitchen", "present": ["Role B"]}
    assert "left the kitchen" in ch._render_presence_movement(prev, cur)
    cue = ch._render_presence_movement(prev, cur, room_names=NAMES)
    assert "Role A has left the Galley" in cue and "Role B has come into the Galley" in cue and "the the" not in cue.lower()
    # A sentence that names the houseguest's real room by its themed name is not a wrong-room placement.
    line = "Role A lounges in the Galley, eyeing the backyard."
    assert ch._wrong_room_claims(line, {"Role A": "kitchen"}) == [("Role A", "kitchen")]
    assert ch._wrong_room_claims(line, {"Role A": "kitchen"}, NAMES) == []


def test_presence_facts_count_a_themed_adjacent_room_as_elsewhere():
    state = {"whereabouts": {"room": "bedroom-a", "present": [], "nearby": [{"room": "kitchen", "present": [{"id": "npc:1", "name": "Role A"}]}],
                             "roomNames": NAMES}, "house": [{"id": "npc:1", "name": "Role A", "status": "active"}]}
    facts = ch._presence_facts(state)
    assert ch._sentence_frames_elsewhere("Role A stirs a pot in the Galley.", facts)
    assert facts["room_names"] == NAMES


def test_briefing_audit_accepts_the_themed_room():
    from routes.briefing import build_briefing
    from routes.briefing_audit import audit_briefing
    b = build_briefing({"whereabouts": {"room": "bedroom-a", "present": [], "roomNames": NAMES}}, zero_clocks=False)
    assert b.location_name == "the Coral Reef Room"
    msgs = [{"role": "system", "content": "    Your room: the Coral Reef Room (you've been here a moment)."}]
    assert [c for c in audit_briefing(msgs, b) if c["fact"] == "player-room"] == []


def test_move_belts_list_themed_names_only_with_a_theme(monkeypatch):
    plain = al._player_move_instructions()
    assert "this season" not in plain and "this season" not in al._npc_move_instructions()
    themed = al._player_move_instructions(NAMES)
    assert "bedroom-a (this season: the Coral Reef Room)" in themed and "kitchen (this season: the Galley)" in themed
    assert "reply with its id" in themed and "living-room," in themed  # an unnamed room stays a bare id
    # The answer stays an id; an echo of the themed listing (or the themed name) still maps to it, and nothing else does.
    from src.house_rooms import room_id_of
    assert [room_id_of(v, NAMES) for v in ("bedroom-a", "bedroom-a (this season: the Coral Reef Room)", "Coral Reef Room", "the attic", None)] == \
        ["bedroom-a", "bedroom-a", "bedroom-a", None, None]
    assert room_id_of("Coral Reef Room") is None
    # The belts read the names pinned at this turn's framing (no engine read).
    monkeypatch.setitem(ch._TURN_WHEREABOUTS, "orw466-owner", {"room": "kitchen", "roomNames": NAMES})
    sent = {}

    async def spy(*a, **k):
        sent["sys"] = k["messages"][0]["content"]
        return ""
    monkeypatch.setattr(llm_core, "llm_call_async", spy)
    asyncio.run(al._move_player_extract("n", "u", "http://x", "m", {}, "orw466-owner"))
    assert "bedroom-a (this season: the Coral Reef Room)" in sent["sys"]


def _room_label_js():
    with open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static/js/orwellPresence.js"), encoding="utf-8") as f:
        js = f.read()
    start = js.index("function roomLabel(")
    return js[start:js.index("// ── the single name-formatting helper", start)].strip(), js


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_presence_gadget_room_label():
    src, js = _room_label_js()
    assert "roomLabel(w.room, roomNames)" in js and "roomLabel(n.room, roomNames)" in js and "roomLabel(t.room, roomNames, true)" in js
    harness = src + "\nconst N = " + json.dumps(NAMES) + ";\nconsole.log(JSON.stringify([roomLabel('bedroom-a', N), roomLabel('kitchen', N, true), roomLabel('bedroom-b', N), roomLabel('bedroom-b')]));\n"
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
        f.write(harness)
        path = f.name
    try:
        out = subprocess.run(["node", path], capture_output=True, text=True, timeout=20)
    finally:
        os.unlink(path)
    assert out.returncode == 0, out.stderr
    assert json.loads(out.stdout.strip().splitlines()[-1]) == ["The Coral Reef Room", "the Galley", "Bedroom B", "Bedroom B"]


# Review of #2856: every room check the front end runs knows the season's names by any form the engine takes (short, accent-folded, curly apostrophe), and stays as before without a theme.
THEMED = {"kitchen": "the Galley", "bedroom-a": "the Coral Reef Room", "backyard": "Main Street", "hoh-room": "the Captain's Quarters", "lounge": "the Séance Room",
          "storage-room": "the Hold"}


def test_move_extraction_answer_takes_the_short_and_folded_forms():
    from src.house_rooms import room_id_of
    assert [room_id_of(v, THEMED) for v in ("the coral reef", "Coral Reef", "Seance Room", "the séance", "Captain’s Quarters", "Hold", "Main Street")] == \
        ["bedroom-a", "bedroom-a", "lounge", "lounge", "hoh-room", "storage-room", "backyard"]
    assert room_id_of("the coral reef") is None and room_id_of("Seance Room") is None


def test_move_prefilter_hears_a_themed_destination(monkeypatch):
    line = "She leaves for the Coral Reef Room."
    assert not al._MOVE_SIGNAL_RE.search(line)  # the plain-word regex cannot know a themed name
    monkeypatch.setitem(ch._TURN_WHEREABOUTS, "orw466-sig", {"room": "kitchen", "roomNames": THEMED})
    assert al._themed_move_signal(line, "orw466-sig") and al._themed_move_signal("he returns to the coral reef", "orw466-sig")
    assert not al._themed_move_signal(line, "orw466-none")  # no theme: nothing new
    src = open(al.__file__, encoding="utf-8").read()
    assert "or _themed_move_signal(_last_user_for_move, owner)" in src and src.count("or _themed_move_signal(_turn_narration_visible, owner)") == 2


def test_player_just_moved_clause_uses_the_themed_names():
    wa = {"room": "bedroom-a", "present": [], "roomNames": NAMES}
    d = ch._whereabouts_barrier_directive(wa, player_move={"from": "kitchen", "to": "bedroom-a"})
    assert "THE PLAYER JUST MOVED: from the Galley to the Coral Reef Room (the engine has already done it). Open this turn's scene in the Coral Reef Room," in d
    assert "never in the Galley," in d and "bedroom a" not in d and "the the" not in d.lower()
    plain = ch._whereabouts_barrier_directive({"room": "bedroom-a", "present": []}, player_move={"from": "kitchen", "to": "bedroom-a"})
    assert "THE PLAYER JUST MOVED: from the kitchen to the bedroom a (the engine has already done it). Open this turn's scene in the bedroom a," in plain


def test_empty_room_and_evicted_checks_know_the_themed_names(monkeypatch):
    assert ch._empty_room_claims("The Galley is empty.") == []
    [claim] = ch._empty_room_claims("The Galley is empty.", THEMED)
    assert claim.rooms == ("kitchen",)
    assert ch._engine_count_mismatch("The Galley is empty.", {"rooms": {"kitchen": 2}, "room_names": THEMED}) is not None
    assert ch._sentence_has_headcount_claim("The Galley is empty.", THEMED) and not ch._sentence_has_headcount_claim("The Galley is empty.")
    gone = ["Role Gone"]
    assert ch._sentence_places_evicted("Role Gone walks into the Captain’s Quarters.", gone) is None
    assert ch._sentence_places_evicted("Role Gone walks into the Captain’s Quarters.", gone, THEMED) == "Role Gone"
    # The streamed guard reads the names pinned at this turn's framing (no engine read).
    monkeypatch.setitem(ch._LAST_BEAT_SIG, "orw466-ev", {"phase": "nominations", "evictedNames": gone})
    monkeypatch.setitem(ch._TURN_WHEREABOUTS, "orw466-ev", {"room": "kitchen", "roomNames": THEMED})
    monkeypatch.setattr(ch, "_reground_enqueue", lambda *a, **k: None)
    assert asyncio.run(ch.screen_streamed_location("orw466-ev", "Role Gone walks into Main Street.")) is False


def test_presence_checks_take_a_short_or_folded_themed_name():
    assert ch._room_keys("Role A sits in the Coral Reef.") == set()
    assert ch._room_keys("Role A sits in the Coral Reef.", THEMED) == {"bedroom"}
    assert ch._room_keys("Role A sits in the Galley.", THEMED) == {"kitchen"}
    assert ch._room_keys("Hold on, Role A says.", THEMED) == set()  # a one-word bare form is never looked for in prose
    state = {"whereabouts": {"room": "kitchen", "present": [], "nearby": [{"room": "bedroom-a", "present": [{"id": "npc:1", "name": "Role A"}]},
                                                                               {"room": "lounge", "present": []}], "roomNames": THEMED},
             "house": [{"id": "npc:1", "name": "Role A", "status": "active"}]}
    facts = ch._presence_facts(state)
    assert ch._sentence_frames_elsewhere("Role A laughs in the Coral Reef.", facts)
    assert ch._sentence_frames_elsewhere("Role A laughs in the Seance Room.", facts)
    plain = ch._presence_facts({**state, "whereabouts": {k: v for k, v in state["whereabouts"].items() if k != "roomNames"}})
    assert "adjacent_room_ids" not in plain and not ch._sentence_frames_elsewhere("Role A laughs in the Coral Reef.", plain)


def test_briefing_audit_reads_every_themed_room_line():
    from routes.briefing import build_briefing
    from routes.briefing_audit import audit_briefing
    b = build_briefing({"whereabouts": {"room": "kitchen", "present": [], "roomNames": THEMED}}, zero_clocks=False)

    def flagged(line):
        return [c for c in audit_briefing([{"role": "system", "content": "    Your room: " + line + " (you've been here a moment)."}], b) if c["fact"] == "player-room"]
    assert flagged("the Galley") == []
    assert flagged("Main Street") and flagged("the Captain's Quarters") and flagged("the Séance Room")
    lounge = build_briefing({"whereabouts": {"room": "lounge", "present": [], "roomNames": THEMED}}, zero_clocks=False)
    assert [c for c in audit_briefing([{"role": "system", "content": "    Your room: the Séance Room (here a moment)."}], lounge) if c["fact"] == "player-room"] == []


# ORW-711: the landing at the top of the stairs is a room the map names, plain or themed, and the front end's room list carries it.
@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_presence_gadget_names_the_landing():
    import src.house_rooms as hr
    assert "landing" in hr.HOUSE_ROOMS
    src, _js = _room_label_js()
    harness = src + "\nconsole.log(JSON.stringify([roomLabel('landing'), roomLabel('landing', {landing: 'the Quarterdeck'}), roomLabel('landing', {landing: 'the Quarterdeck'}, true)]));\n"
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
        f.write(harness)
        path = f.name
    try:
        out = subprocess.run(["node", path], capture_output=True, text=True, timeout=20)
    finally:
        os.unlink(path)
    assert out.returncode == 0, out.stderr
    assert json.loads(out.stdout.strip().splitlines()[-1]) == ["Landing", "The Quarterdeck", "the Quarterdeck"]

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

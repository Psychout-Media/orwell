"""ADR 0009 NPC auto-move belt: a room a HOUSEGUEST walks to (in the narration) but the model never
moveHouseguest's is folded into the engine's OPEN occupancy by the FE.

The mirror of L21/L24 (the player belt) for the other 15 people. The model reliably UNDER-calls
moveHouseguest: it narrates "Marcus heads to the kitchen" but never moves the engine — so next turn the
whereabouts gadget snaps Marcus back to his seeded room (the chat↔board location desync). The FE now
back-fills the move via a constrained extraction: only a houseguest the narration clearly walked to a
room is relayed, the ENGINE decides legality (it refuses the player / a non-existent houseguest / the
diary room / an unwalkable room and no-ops a same-room move), and we count only the moves the engine
actually applied. Vault-free (whereabouts is a Vault-free projection).

SYNC tests only (pytest-asyncio AUTO mode) — drive coroutines via run_until_complete, never asyncio.run().
"""

import asyncio
import importlib

al = importlib.import_module("src.agent_loop")
orwell_engine = importlib.import_module("src.orwell_engine")
llm_core = importlib.import_module("src.llm_core")

# A roster with NO player — the belt only ever relays a houseguest in this set.
_HOUSE = [
    {"id": "npc:1", "name": "Houseguest One"},
    {"id": "npc:2", "name": "Houseguest Two"},
    {"id": "npc:3", "name": "Houseguest Three"},
]


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _wire(monkeypatch, extraction_json, calls, status="moved"):
    """Stub the extraction LLM and move_houseguest. `status` is what the engine reports for each move
    (the authority on legality); `calls` records every (id, room, user) the belt relayed."""
    async def fake_llm(*a, **k):
        return extraction_json

    async def fake_move_houseguest(houseguest_id, room, user=None):
        calls.append({"id": houseguest_id, "room": room, "user": user})
        return {"status": status, "whereabouts": {"room": room, "present": [], "nearby": []}}

    monkeypatch.setattr(llm_core, "llm_call_async", fake_llm)
    monkeypatch.setattr(orwell_engine, "move_houseguest", fake_move_houseguest)


def test_npc_walk_is_backfilled(monkeypatch):
    calls = []
    _wire(monkeypatch, '{"moves":[{"id":"npc:1","room":"kitchen"}]}', calls)
    out = _run(al._auto_move_npc("Houseguest One heads to the kitchen for coffee.",
                                 "I stay put", _HOUSE, "url", "m", {}, "owner"))
    assert out == 1
    assert calls == [{"id": "npc:1", "room": "kitchen", "user": "owner"}]


def test_multiple_npcs_move_in_one_scene(monkeypatch):
    calls = []
    _wire(monkeypatch,
          '{"moves":[{"id":"npc:1","room":"backyard"},{"id":"npc:2","room":"bedroom-a"}]}', calls)
    out = _run(al._auto_move_npc("One and Two drift out back, then Two slips into the bedroom.",
                                 "x", _HOUSE, "url", "m", {}, "owner"))
    assert out == 2
    assert {c["id"] for c in calls} == {"npc:1", "npc:2"}


def test_no_move_creates_no_phantom_move(monkeypatch):
    calls = []
    _wire(monkeypatch, '{"moves":[]}', calls)
    out = _run(al._auto_move_npc("Everyone stays in the living room, talking.",
                                 "I listen", _HOUSE, "url", "m", {}, "owner"))
    assert out == 0
    assert calls == [], "a turn where no houseguest moved must never relocate anyone"


def test_unknown_houseguest_is_rejected(monkeypatch):
    calls = []
    _wire(monkeypatch, '{"moves":[{"id":"npc:999","room":"kitchen"}]}', calls)
    out = _run(al._auto_move_npc("Someone off the roster moves.", "x", _HOUSE, "url", "m", {}, "owner"))
    assert out == 0
    assert calls == [], "only a houseguest in the roster is ever relayed to the engine"


def test_unknown_room_is_rejected(monkeypatch):
    calls = []
    _wire(monkeypatch, '{"moves":[{"id":"npc:1","room":"rooftop-helipad"}]}', calls)
    out = _run(al._auto_move_npc("They climb somewhere off the map.", "x", _HOUSE, "url", "m", {}, "owner"))
    assert out == 0
    assert calls == [], "only a real house room is ever relayed to the engine"


def test_diary_room_is_rejected(monkeypatch):
    # The diary room is the player's isolated OOC channel — an NPC never walks into it (the engine
    # refuses it too, but we filter client-side so we never even issue the call).
    calls = []
    _wire(monkeypatch, '{"moves":[{"id":"npc:1","room":"diary-room"}]}', calls)
    out = _run(al._auto_move_npc("scene", "x", _HOUSE, "url", "m", {}, "owner"))
    assert out == 0
    assert calls == []


def test_duplicate_ids_are_deduped(monkeypatch):
    calls = []
    _wire(monkeypatch,
          '{"moves":[{"id":"npc:1","room":"kitchen"},{"id":"npc:1","room":"backyard"}]}', calls)
    out = _run(al._auto_move_npc("scene", "x", _HOUSE, "url", "m", {}, "owner"))
    assert out == 1
    assert calls == [{"id": "npc:1", "room": "kitchen", "user": "owner"}], "first move per houseguest wins"


def test_moves_are_capped_per_turn(monkeypatch):
    calls = []
    rooms = ["kitchen", "backyard", "bedroom-a", "bedroom-b", "bathroom"]
    moves = ",".join('{"id":"npc:%d","room":"%s"}' % (i + 1, r) for i, r in enumerate(rooms))
    big_house = [{"id": f"npc:{i+1}", "name": f"HG {i+1}"} for i in range(len(rooms))]
    _wire(monkeypatch, '{"moves":[' + moves + ']}', calls)
    out = _run(al._auto_move_npc("a big shuffle", "x", big_house, "url", "m", {}, "owner"))
    assert out == al._MAX_NPC_MOVES_PER_TURN
    assert len(calls) == al._MAX_NPC_MOVES_PER_TURN, "never relay more than the per-turn cap"


def test_illegal_or_noop_status_is_not_counted(monkeypatch):
    # The engine is the authority: a relayed move it rules "illegal" (or a "noop" same-room) is issued
    # but does not count as an applied move.
    for status in ("illegal", "noop"):
        calls = []
        _wire(monkeypatch, '{"moves":[{"id":"npc:1","room":"kitchen"}]}', calls, status=status)
        out = _run(al._auto_move_npc("scene", "x", _HOUSE, "url", "m", {}, "owner"))
        assert out == 0, f"status={status} must not count as an applied move"
        assert len(calls) == 1, "the call is still issued — the engine rules on it"


def test_extraction_after_a_reasoning_block_is_parsed(monkeypatch):
    # Reasoning models emit the answer LAST — the last {"moves":...} object wins.
    calls = []
    _wire(monkeypatch,
          'Let me see who moved... One went to the kitchen.\n{"moves":[{"id":"npc:1","room":"kitchen"}]}',
          calls)
    out = _run(al._auto_move_npc("Houseguest One heads to the kitchen.", "x", _HOUSE, "url", "m", {}, "owner"))
    assert out == 1 and calls[0]["room"] == "kitchen"


def test_extraction_hiccup_is_fail_open(monkeypatch):
    calls = []

    async def boom(*a, **k):
        raise RuntimeError("llm down")

    async def fake_move_houseguest(*a, **k):
        calls.append(a)
        return {"status": "moved"}

    monkeypatch.setattr(llm_core, "llm_call_async", boom)
    monkeypatch.setattr(orwell_engine, "move_houseguest", fake_move_houseguest)
    out = _run(al._auto_move_npc("One heads to the kitchen", "x", _HOUSE, "url", "m", {}, "owner"))
    assert out == 0 and calls == []


def test_unparseable_json_is_a_noop(monkeypatch):
    calls = []
    _wire(monkeypatch, "no json here at all", calls)
    out = _run(al._auto_move_npc("One heads to the kitchen", "x", _HOUSE, "url", "m", {}, "owner"))
    assert out == 0 and calls == []


def test_empty_roster_is_a_noop(monkeypatch):
    calls = []
    _wire(monkeypatch, '{"moves":[{"id":"npc:1","room":"kitchen"}]}', calls)
    out = _run(al._auto_move_npc("scene", "x", [], "url", "m", {}, "owner"))
    assert out == 0 and calls == [], "no roster ⇒ nothing to map a name onto"


def test_auto_move_npc_is_wired_into_the_finishing_block():
    import os
    js = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                           "src", "agent_loop.py"), encoding="utf-8").read()
    assert "async def _auto_move_npc" in js
    # gated on: model didn't moveHouseguest + the per-turn cap + the cheap movement pre-filter over the
    # whole turn's NARRATION (where NPCs move). CodeRabbit (BL-013/033, finding 1): the pre-filter reads
    # the VISIBLE narration (<think> reasoning stripped) so a "move X to the kitchen" inside reasoning
    # can't drive a persisted NPC relocation the player never saw.
    assert '_npc_moved = "moveHouseguest" in _tool_names' in js
    # A60: the gate expression now lives in agent_gates.want_npc_move (called by the loop); same conditions
    assert "_want_npc_move = _gates.want_npc_move(" in js
    _gates = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "agent_gates.py"), encoding="utf-8").read()
    assert "(not npc_moved)" in _gates and "turn_npc_move_nudges < max_npc_move_nudges" in _gates
    assert "_MOVE_SIGNAL_RE.search(_turn_narration_visible)" in js
    # the fetch-guard includes the NPC-move belt, and the call site fires inside it — VISIBLE narration
    assert "_want_move or _want_npc_move" in js
    assert "await _auto_move_npc(_turn_narration_visible, _last_user_for_move" in js
    # model-driven moveHouseguest always wins (_npc_moved short-circuits _want_npc_move)


def test_house_rooms_exclude_diary_room_for_npcs():
    # The belt offers NPCs every walkable room EXCEPT the player's diary room.
    assert "diary-room" in al._HOUSE_ROOMS  # the player's DR is still a real room…
    # …but the NPC extraction prompt and the client-side filter both exclude it (asserted via behavior
    # in test_diary_room_is_rejected). Keep the floor plan in lockstep with the engine.
    assert set(al._HOUSE_ROOMS) == {
        "kitchen", "living-room", "backyard", "bedroom-a", "bedroom-b",
        "hoh-room", "bathroom", "storage-room", "diary-room",
    }

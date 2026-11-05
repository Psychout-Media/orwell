"""L21/L24 auto-move belt: a room the player walks to but the model never moveTo's is persisted by the FE.

Whereabouts cohesion — "the single biggest immersion-killer" (ledger L24). The engine grounding shipped
(whereabouts() in the per-turn context; the player is PINNED and only an explicit `moveTo` relocates them).
But the model reliably UNDER-calls `moveTo`: the player says "I head to the kitchen", the narrator voices
the kitchen, but never moves the engine — so next turn whereabouts still reports the OLD room and the
picture snaps back. The FE now back-fills the move via a constrained extraction: only a room the player
clearly walked to is relayed (room:null → nothing happens), so the engine's persisted occupancy agrees
with the narration the player already saw. Vault-free (whereabouts is a Vault-free projection).

SYNC tests only (pytest-asyncio AUTO mode) — drive coroutines via run_until_complete, never asyncio.run().
"""

import asyncio
import importlib

al = importlib.import_module("src.agent_loop")
orwell_engine = importlib.import_module("src.orwell_engine")
llm_core = importlib.import_module("src.llm_core")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _wire(monkeypatch, extraction_json, moves):
    async def fake_llm(*a, **k):
        return extraction_json

    async def fake_move_to(room, expected_beat_seq=None, user=None):
        moves.append({"room": room, "user": user})
        return {"whereabouts": {"room": room, "present": [], "nearby": []}}

    monkeypatch.setattr(llm_core, "llm_call_async", fake_llm)
    monkeypatch.setattr(orwell_engine, "move_to", fake_move_to)


def test_player_walk_is_backfilled(monkeypatch):
    moves = []
    _wire(monkeypatch, '{"room":"kitchen"}', moves)
    out = _run(al._auto_move_player("You drift into the kitchen, where the coffee is brewing.",
                                    "I head to the kitchen", "url", "m", {}, "owner"))
    assert out is True
    assert len(moves) == 1
    assert moves[0]["room"] == "kitchen" and moves[0]["user"] == "owner"


def test_no_move_creates_no_phantom_move(monkeypatch):
    moves = []
    _wire(monkeypatch, '{"room":null}', moves)
    out = _run(al._auto_move_player("You stay on the couch, half-listening.",
                                    "I just sit and watch", "url", "m", {}, "owner"))
    assert out is False
    assert moves == [], "a turn where the player did not move must never relocate them"


def test_unknown_room_is_rejected(monkeypatch):
    moves = []
    _wire(monkeypatch, '{"room":"rooftop-helipad"}', moves)
    out = _run(al._auto_move_player("You climb somewhere off the map.", "x", "url", "m", {}, "owner"))
    assert out is False
    assert moves == [], "only a real house room is ever relayed to the engine"


def test_every_house_room_is_accepted(monkeypatch):
    # The extraction may name any canonical room; each must be relayed verbatim.
    for room in al._HOUSE_ROOMS:
        moves = []
        _wire(monkeypatch, '{"room":"' + room + '"}', moves)
        out = _run(al._auto_move_player("scene", "move", "url", "m", {}, "owner"))
        assert out is True and moves and moves[0]["room"] == room


def test_extraction_after_a_reasoning_block_is_parsed(monkeypatch):
    # Reasoning models emit the answer LAST — the last {"room":...} object wins.
    moves = []
    _wire(monkeypatch,
          'Let me think... the player said "out back" which maps to the yard.\n{"room":"backyard"}',
          moves)
    out = _run(al._auto_move_player("You step out into the night air of the backyard.",
                                    "let's go out back", "url", "m", {}, "owner"))
    assert out is True and moves[0]["room"] == "backyard"


def test_extraction_hiccup_is_fail_closed(monkeypatch):
    moves = []

    async def boom(*a, **k):
        raise RuntimeError("llm down")

    async def fake_move_to(*a, **k):
        moves.append(a)
        return {}

    monkeypatch.setattr(llm_core, "llm_call_async", boom)
    monkeypatch.setattr(orwell_engine, "move_to", fake_move_to)
    out = _run(al._auto_move_player("scene", "I head to the kitchen", "url", "m", {}, "owner"))
    assert out is False and moves == []


def test_unparseable_json_is_a_noop(monkeypatch):
    moves = []
    _wire(monkeypatch, "no json here at all", moves)
    out = _run(al._auto_move_player("scene", "I head to the kitchen", "url", "m", {}, "owner"))
    assert out is False and moves == []


def test_move_signal_regex_targets_movement_language():
    rx = al._MOVE_SIGNAL_RE
    for hit in ["I head to the kitchen", "let's go out back", "I wander into the living room",
                "walk over to the bedroom", "I step into the bathroom", "going to the storage room",
                "I'll head up to the HOH room", "I drift toward the backyard", "I slip into bedroom-a",
                "I stroll to the lounge", "moving to the kitchen"]:
        assert rx.search(hit), hit
    # #536 / ISSUE-8: STATIC in-room presence language (no movement verb) must ALSO trip the belt — a
    # houseguest described sitting/leaning/lounging in a room is invented static presence the NPC-move
    # extraction needs to reconcile against the engine.
    for hit in ["she sits at the kitchen counter", "he leans against the backyard fence",
                "they lounge in the living room", "perched on the bathroom counter",
                "standing in the storage room", "sprawled across the bedroom floor",
                "lingering by the HOH room door"]:
        assert rx.search(hit), hit
    # PARITY-2 / BL-013: widen the belt vocabulary — the player-move belt was defeated by
    # "follow/explore/meet/find/join/visit" and by common typos ("movining", "goining"). Add the verbs
    # + typo-tolerant stems; the constrained extraction is still the gatekeeper (room:null when no move).
    for hit in ["I follow them out back", "let's explore the house", "I go find the others",
                "I'll join everyone in the living room", "I want to visit the HOH room",
                "let me check the backyard", "I head off to meet the group",
                "movining to the kitchen", "goining out back", "I wanna go hunt for allies"]:
        assert rx.search(hit), hit
    # CodeRabbit (BL-013/033): PAST-TENSE forms too — "you followed them out back" has no room token,
    # so without the -ed / irregular past forms a narrated past-tense relocation stays unpersisted.
    for hit in ["you followed them out back", "she headed to the kitchen", "he walked into the lounge",
                "they wandered off", "you strolled toward the yard", "he drifted away",
                "she slipped out", "you stepped inside", "you explored the house",
                "you met them by the pool", "you found her in the storage room",
                "they joined the others", "you visited the HOH room", "he checked the backyard",
                "you hunted around for allies"]:
        assert rx.search(hit), hit
    for miss in ["I tell her she looks tired", "what time is it in-game?",
                 "I think Cynthia is lying to me", "who is HOH right now?"]:
        assert not rx.search(miss), miss


# ── CodeRabbit BL-013/033 (finding 1): the belts read the VISIBLE narration, never <think> reasoning ──

def test_visible_move_narration_strips_think_reasoning():
    # Movement language that lives ONLY inside a <think> block must NOT survive into the belt's view —
    # otherwise private reasoning ("I should move the player to the kitchen") drives a PERSISTED move the
    # player never saw (a reasoning-leak-INTO-behavior). This pins the finding-1 fix.
    vis = al._visible_move_narration(
        "<think>I should move the player to the kitchen for the next beat.</think>"
        "You keep quiet, arms crossed, and say nothing.")
    assert "kitchen" not in vis, "reasoning content must be stripped from the belt's narration"
    assert not al._MOVE_SIGNAL_RE.search(vis), "think-only movement must not trip the move pre-filter"


def test_visible_move_narration_keeps_visible_movement():
    vis = al._visible_move_narration(
        "You head to the kitchen for coffee. <think>the player seems thirsty</think>")
    assert al._MOVE_SIGNAL_RE.search(vis), "movement in the VISIBLE body must still trip the pre-filter"
    assert "<think>" not in vis and "thirsty" not in vis, "the reasoning tail is still stripped"


def test_player_move_belt_gate_ignores_think_only_movement(monkeypatch):
    # Behavior (finding 1): the player-move belt's gate is (player msg OR visible narration). A turn
    # whose movement language is ONLY inside <think> must NOT select _auto_move_player; a turn with
    # VISIBLE movement must — and the extraction is then fed the VISIBLE narration (no reasoning).
    calls = []

    async def _rec(narration, *a, **k):
        calls.append(narration)
        return True

    monkeypatch.setattr(al, "_auto_move_player", _rec)

    def _belt_would_fire(last_user, turn_narration):
        # mirrors the loop's `_want_move` narration branch exactly
        vis = al._visible_move_narration(turn_narration)
        return bool(al._MOVE_SIGNAL_RE.search(last_user or "")
                    or al._MOVE_SIGNAL_RE.search(vis))

    # (a) movement ONLY in <think>, player said nothing move-y → the belt must NOT fire
    think_turn = "<think>move the player to the kitchen</think>You watch the others in silence."
    assert _belt_would_fire("I keep quiet and listen", think_turn) is False
    assert calls == [], "a think-only 'move' must never call _auto_move_player"

    # (b) VISIBLE movement → the belt fires, and _auto_move_player receives the VISIBLE narration
    visible_turn = "You wander out to the backyard for some air. <think>the player wants space</think>"
    assert _belt_would_fire("hmm", visible_turn) is True
    _run(al._auto_move_player(al._visible_move_narration(visible_turn), "hmm", "u", "m", {}, "o"))
    assert calls and "<think>" not in calls[0] and "space" not in calls[0], (
        "the extraction is fed the player-visible narration, never the reasoning channel")


def test_belt_reads_emitted_visible_not_guard_dropped_sentences():
    # CodeRabbit MAJOR (data-integrity): a movement sentence a VISIBILITY guard dropped (the
    # scene-break / knowledge-wall guard) is still present in raw round_texts but ABSENT from the
    # emitted `full_response` the belts now read. So a guard-excised movement sentence must NOT drive a
    # move. Throwaway text exercises the derivation the loop uses (`_visible_move_narration` over the
    # emitted-visible text) — the loop feeds `full_response`, not raw round_texts.
    raw_round_texts = ("You slip into the HOH room to read the sealed note.\n"
                       "You keep chatting on the couch.")           # what round_texts retained
    emitted_visible = "You keep chatting on the couch."             # the HOH-room line was excised
    # The RAW text DID carry a move signal — proving the sentence is the kind the belt would act on …
    assert al._MOVE_SIGNAL_RE.search(al._visible_move_narration(raw_round_texts))
    # … but the emitted-VISIBLE narration the belt actually reads has no movement signal → no move.
    assert not al._MOVE_SIGNAL_RE.search(al._visible_move_narration(emitted_visible)), (
        "a visibility-guard-dropped movement sentence is absent from the emitted narration → "
        "neither auto-move belt may fire on it")


def test_auto_move_is_wired_into_the_finishing_block():
    import os
    js = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                           "src", "agent_loop.py"), encoding="utf-8").read()
    assert "async def _auto_move_player" in js
    # 0065: routed through the CAS helper so the back-fill carries the compare-and-swap beatSeq token.
    assert "_backfill_with_cas(owner, _oe.move_to, room, user=owner)" in js
    # gated on: model didn't moveTo + the per-turn cap + the cheap movement pre-filter. PARITY-2 /
    # BL-013: the player belt now reads the NARRATION as well as the player's own message (mirroring the
    # NPC belt), so a player relocation the narration describes precisely — but the player's own message
    # missed ("follow them", a typo) — still back-fills. The constrained extraction stays the gatekeeper.
    assert "_moved = bool(_tool_names & _MOVE_TOOLS)" in js
    # A60: the gate expression now lives in agent_gates.want_move (called by the loop); same conditions
    assert "_want_move = _gates.want_move(" in js
    _gates = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "agent_gates.py"), encoding="utf-8").read()
    assert "(not moved)" in _gates and "turn_move_nudges < max_move_nudges" in _gates
    assert "_MOVE_SIGNAL_RE.search(_last_user_for_move)" in js
    # CodeRabbit (finding 1 + the MAJOR refinement): the belt gates on the emitted PLAYER-VISIBLE
    # narration — `full_response` (post game-scrub + post scene/knowledge guards) — NOT raw round_texts,
    # which retain <think> reasoning AND every visibility-guard-dropped sentence. So neither private
    # reasoning nor a knowledge-wall-excised movement sentence can drive a persisted move.
    assert "_turn_narration_visible = _visible_move_narration(full_response)" in js
    assert "_MOVE_SIGNAL_RE.search(_turn_narration_visible)" in js  # the belt gates on the VISIBLE narration
    # fetch-guard includes the move belt, and the call site fires inside it — fed the VISIBLE narration
    assert "_want_advance or _want_record or _want_deal or _want_move" in js
    assert "await _auto_move_player(_turn_narration_visible, _last_user_for_move" in js
    # model-driven moveTo always wins (_moved short-circuits _want_move)
    assert "_MOVE_TOOLS = {\"moveTo\"}" in js


def test_house_rooms_mirror_the_engine_floor_plan():
    # Keep the FE room list in lockstep with src/domain/house.ts HOUSE_ROOMS — a drift means the
    # extraction would reject a real room (or relay a bogus one the engine no-ops).
    assert set(al._HOUSE_ROOMS) == {
        "kitchen", "living-room", "backyard", "bedroom-a", "bedroom-b",
        "hoh-room", "bathroom", "storage-room", "diary-room",
    }

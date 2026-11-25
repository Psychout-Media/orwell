"""ORW-918 (Fable week-1 playtest, the room part): the player says where they are going, the narration keeps them where they were (it never voices the walk), and
the FE auto-move belt still moved the ENGINE to the room the player named. The engine then had the player alone in the yard while the narration had four houseguests
talking to them in the lounge, and the house's scenes in the room the player never saw were recorded as witnessed by them (they rode the bedtime recap).
The belt exists to make the engine agree with the narration the player already saw (L21/L24), so a room the narration places the player AWAY from is never relayed.
Also: a season room name with a hyphen ("the Ring-Toss Lounge") was never recognised in text at all. Roles only; no live model (the extraction is a stub)."""
import asyncio
import importlib

al = importlib.import_module("src.agent_loop")
orwell_engine = importlib.import_module("src.orwell_engine")
llm_core = importlib.import_module("src.llm_core")
from src.house_rooms import themed_rooms_in, rooms_named_in

NAMES = {"living-room": "The Ring-Toss Lounge", "backyard": "The Midway Yard", "bedroom-a": "The Six-Strider Bunk", "hallway": "The Calliope Corridor",
         "kitchen": "Cotton Candy Galley"}


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _wire(monkeypatch, extraction_json, moves):
    async def fake_llm(*a, **k):
        return extraction_json

    async def fake_move_to(room, expected_beat_seq=None, user=None):
        moves.append(room)
        return {"whereabouts": {"room": room, "present": [], "nearby": []}}

    monkeypatch.setattr(llm_core, "llm_call_async", fake_llm)
    monkeypatch.setattr(orwell_engine, "move_to", fake_move_to)
    monkeypatch.setattr(al, "_season_room_names", lambda owner: NAMES)


def test_a_hyphenated_season_room_name_is_recognised_in_text():
    assert themed_rooms_in("Evening light fills the Ring-Toss Lounge.", NAMES) == ["living-room"]
    assert themed_rooms_in("the ring toss lounge", NAMES) == ["living-room"], "typed without the hyphen it is the same room"


def test_plain_room_words_are_recognised_too():
    named = rooms_named_in("Veto talk and the low hum of the lounge carry on around you.", NAMES)
    assert any("living-room" in c for c in named), "'the lounge' can be this season's living room"
    assert rooms_named_in("He sits on the edge of his bunk.", NAMES) and rooms_named_in("You step out into the backyard.", NAMES)
    assert rooms_named_in("Nothing here names a place.", NAMES) == []


def test_the_player_asks_to_step_out_but_the_narration_keeps_them_in_the_lounge_no_move(monkeypatch):
    """Turn 147's shape: the player asks a houseguest to step out to the yard; the narration stays in the lounge with the others; the extraction answers the yard."""
    moves = []
    _wire(monkeypatch, '{"room":"backyard"}', moves)
    out = _run(al._auto_move_player(
        "Veto talk and the low hum of the lounge carry on around you, the striped accent wall, a mug left on the table. A houseguest says it low: those two not talking is worth more than anything said in this room.",
        "I ask a houseguest to step out to the backyard with me, just the two of us.", "url", "m", {}, "owner"))
    assert out is False and moves == [], "the narration kept the player in the lounge: the engine must not put them in the yard"


def test_going_to_bed_but_narrated_in_the_ring_toss_lounge_no_move_to_the_bunk(monkeypatch):
    """Turn 107/130's shape: 'I go up to my bunk', the narration voices the Ring-Toss Lounge (a themed name with a hyphen)."""
    moves = []
    _wire(monkeypatch, '{"room":"bedroom-a"}', moves)
    out = _run(al._auto_move_player("Pastel light has gone long and peachy and the Ring-Toss Lounge is full of it. A houseguest is already up out of the sectional.",
                                    "That's all from me tonight. I go back to my bunk and sleep.", "url", "m", {}, "owner"))
    assert out is False and moves == []


def test_a_narrated_arrival_still_moves(monkeypatch):
    moves = []
    _wire(monkeypatch, '{"room":"backyard"}', moves)
    assert _run(al._auto_move_player("You step through the glass doors into the Midway Yard; behind you the lounge goes quiet.",
                                     "I go out to the yard.", "url", "m", {}, "owner")) is True
    assert moves == ["backyard"], "the narration shows the player arriving there (another room named in passing does not block it)"


def test_a_narration_that_names_no_room_still_moves(monkeypatch):
    """No room named at all is no evidence against the player's own move (the L21/L24 belt as before)."""
    moves = []
    _wire(monkeypatch, '{"room":"kitchen"}', moves)
    assert _run(al._auto_move_player("You wander off, and the noise thins behind you.", "I head to the kitchen", "url", "m", {}, "owner")) is True
    assert moves == ["kitchen"]


def test_the_extraction_is_told_to_follow_the_narration():
    ins = al._player_move_instructions(NAMES)
    assert "WHAT HAPPENED" in ins and "shows" in ins, "the extraction answers the room the narration shows the player in, not the room they said they'd go to"

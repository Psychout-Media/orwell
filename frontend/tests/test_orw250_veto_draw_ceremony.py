"""ORW-250 (Ryne, playtest 2026-11-07: "The veto player draw was seemingly skipped. That should happen before the veto comp as a mini ceremony. It was expressed as a call from production at the beginning of the comp
instead."): the engine's `veto-draw` beat is committed on the morning of the veto day, but the pre-resolve pass walked straight on from it into the competition's rounds, so the draw was folded into the comp's opening line.
Now the draw ENDS the pass: the narrator is handed the committed draw (exactly six players, the Houseguest's Choice pick if any) to voice as its own short ceremony in the room, and the competition is not walked in the same
pass. Roles only."""
import asyncio
import importlib

ch = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")


def _run(c):
    return asyncio.get_event_loop().run_until_complete(c)


DRAW = "the veto players are drawn for The Wall: Houseguest One, Houseguest Two, Houseguest Three, Houseguest Four, Houseguest Five, Houseguest Six"
HGC = DRAW + " — Houseguest Three draws Houseguest's Choice and will name the sixth houseguest to play"


def test_the_steer_hands_over_the_draw_as_its_own_ceremony_and_forbids_the_comp():
    t = ch._veto_draw_steer(DRAW)
    assert "THE VETO DRAW JUST HAPPENED" in t and DRAW in t
    low = t.lower()
    for need in ("its own short ceremony", "this morning", "each draw is read aloud", "exactly these six", "end there", "do not narrate it, its rounds or a winner"):
        assert need in low, need


def test_a_houseguests_choice_is_voiced_as_given():
    t = ch._veto_draw_steer(HGC).lower()
    assert "draws houseguest's choice" in t and "who they picked to play the sixth seat" in t


def _rig(monkeypatch, user, beats):
    ch.clear_social_runway(user)
    ch._SCHEDULE_STEER.pop(ch._runway_key(user), None)
    seq = list(beats)
    base = {"phase": "veto-competition", "week": 1, "beatSeq": 1}

    async def fake_status(user=None, **kw):
        return {"beatSeq": 1, "pending": None}

    async def fake_advance(expected_beat_seq=None, idempotency_key=None, user=None):
        k, c = seq.pop(0)
        return {"event": {"beat": k, "content": c}, "beatSeq": 2}

    async def fake_state(user=None, **kw):
        return dict(base)

    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    monkeypatch.setattr(orwell_engine, "advance_game", fake_advance)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    return seq, base


def test_the_pass_stops_after_the_draw_and_never_walks_the_competition_with_it(monkeypatch):
    seq, base = _rig(monkeypatch, "u250", [("veto-draw", DRAW), ("comp-elimination", "Houseguest One is out; 5 remain"), ("veto-competition", "Houseguest Six wins the Power of Veto")])
    _run(ch._pre_resolve_npc_ceremony("u250", dict(base), retry=False, player_msg="run it, who plays?"))
    steer = ch._SCHEDULE_STEER.get(ch._runway_key("u250")) or ""
    assert "THE VETO DRAW JUST HAPPENED" in steer and "Houseguest Six" in steer
    assert "THE COMPETITION JUST RAN" not in steer, "the draw is never folded into the competition's opening"
    assert len(seq) == 2, "exactly ONE beat (the draw) was walked: the competition waits for its afternoon"


def test_the_drawn_names_must_be_voiced_or_the_next_turn_regrounds(monkeypatch):
    _rig(monkeypatch, "u250b", [("veto-draw", DRAW)])
    _run(ch._pre_resolve_npc_ceremony("u250b", {"phase": "veto-competition", "week": 1, "beatSeq": 1}, retry=False, player_msg="go"))
    note = ch._CEREMONY_UNVOICED.get(ch._desync_key("u250b")) or {}
    assert "Houseguest One" in (note.get("names") or []) and len(note.get("names") or []) == 6

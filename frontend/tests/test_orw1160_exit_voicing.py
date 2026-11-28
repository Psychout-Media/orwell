"""ORW-1160 / ORW-1159 front end (Ryne 2026-11-28: "there was no transition out"): the engine hands the narrator every departure from the player's room since the last reply (`whereabouts.sinceSend.left`).
A reply that does not voice it is re-grounded into the next turn, the way a committed ceremony beat the reply skipped is. And the houseguests of a scene fold still staged from the last reply are announced to the
engine with the next player message, so the engine keeps them in the room through that message's tick. Roles only - no real names."""
import asyncio
import importlib

ch = importlib.import_module("routes.chat_helpers")
fl = importlib.import_module("src.fold_ledger")
orwell_engine = importlib.import_module("src.orwell_engine")
_USER = "u1160"


def _run(c):
    return asyncio.get_event_loop().run_until_complete(c)


def _quiet(monkeypatch):
    sig = {"week": 1, "phase": "regular", "pending": None, "hoh": None, "noms": [], "vetoHolder": None, "vetoUsed": False, "evicted": 0, "finished": False}
    ch._LAST_BEAT_SIG[_USER] = dict(sig)

    async def fake_capture(user=None):
        return dict(sig)
    monkeypatch.setattr(ch, "_capture_beat_signature", fake_capture)
    ch._CEREMONY_UNVOICED.clear()
    ch._DESYNC_REGROUND.pop(_USER, None)
    getattr(ch, "_EXITS_UNVOICED", {}).clear()


def _wa(left):
    return {"room": "living-room", "present": [], "sinceSend": {"arrived": [], "departed": [l["name"] for l in left], "left": left}}


LEFT = [{"id": "npc:3", "name": "Houseguest Three Alpha", "to": "kitchen", "toName": "the kitchen"}]


def _register(wa):
    assert hasattr(ch, "note_exits_for_voicing"), "the framing must remember each handed-over departure"
    ch.note_exits_for_voicing(_USER, wa)


def test_a_reply_that_never_shows_the_departure_regrounds_the_next_turn(monkeypatch):
    _quiet(monkeypatch)
    _register(_wa(LEFT))
    _run(ch.record_post_turn_desync_check(_USER, "Alpha's answer hangs in the air. Houseguest Three Alpha says the vote is already decided, and the room goes quiet around her."))
    seg = ch._DESYNC_REGROUND.get(_USER) or ""
    assert "RE-GROUND ON AN EXIT" in seg and "Houseguest Three Alpha" in seg and "the kitchen" in seg


def test_a_reply_that_voices_the_departure_queues_nothing(monkeypatch):
    for reply in ("Houseguest Three Alpha pushes back from the table and walks out toward the kitchen, the door swinging behind her.",
                  "Alpha says she needs air. She leaves, and the room is quieter without her.",
                  "Houseguest Three Alpha drifts into the kitchen."):
        _quiet(monkeypatch)
        _register(_wa(LEFT))
        _run(ch.record_post_turn_desync_check(_USER, reply))
        assert _USER not in ch._DESYNC_REGROUND, reply


def test_the_engines_reason_rides_the_reground(monkeypatch):
    _quiet(monkeypatch)
    _register(_wa([{"id": "npc:3", "name": "Houseguest Three Alpha", "to": "diary-room", "toName": "the Diary Room", "why": "production called them to the Diary Room"}]))
    _run(ch.record_post_turn_desync_check(_USER, "The player waits. Nobody speaks."))
    seg = ch._DESYNC_REGROUND.get(_USER) or ""
    assert "production called them to the Diary Room" in seg


def test_a_turn_with_no_departure_clears_the_slot_and_queues_nothing(monkeypatch):
    _quiet(monkeypatch)
    _register(_wa(LEFT))
    _register({"room": "living-room", "present": []})
    _run(ch.record_post_turn_desync_check(_USER, "Nobody is here but you."))
    assert _USER not in ch._DESYNC_REGROUND


def test_the_staged_fold_people_are_read_from_the_ledger_and_announced_with_the_message(monkeypatch):
    assert hasattr(fl, "pending_fold_with_ids"), "the ledger must expose who the staged folds name"
    fl.stage_pending_fold(_USER, "s1160", content="a talk", with_ids=["npc:1", "npc:10"], kind="strategy", consequence=None, felt_minutes=30, idempotency_key="k1")
    try:
        assert fl.pending_fold_with_ids(_USER, "s1160") == ["npc:1", "npc:10"]
        seen = {}

        async def fake_note(message_id, user=None, **kw):
            seen.update(kw)
            return {"accepted": True, "beatSeq": 5}
        monkeypatch.setattr(orwell_engine, "note_message", fake_note)
        _run(ch.note_player_message("m-1160", _USER, "s1160"))
        assert seen.get("with_ids") == ["npc:1", "npc:10"]
    finally:
        fl._PENDING.pop(fl._key(_USER, "s1160"), None)

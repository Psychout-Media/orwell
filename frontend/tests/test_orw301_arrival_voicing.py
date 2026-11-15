"""ORW-301 (premiere entrances): the engine releases ONE arrival per advance and tells the narrator 'JUST ARRIVED: <name>'. In the 2026-11-12 live run the same-round reply named that houseguest in only 3 of 10
logged arrival rounds, and nothing checked the pairing. The premiere framing now remembers each arrival with the committed-beat voicing check, so a reply that names none of them re-grounds the NEXT turn
(never engine-authors content: it only restates the engine's own beat and its name). Roles only - no real names."""
import asyncio
import importlib

ch = importlib.import_module("routes.chat_helpers")
_USER = "u301"


def _run(c):
    return asyncio.get_event_loop().run_until_complete(c)


def _state(name, index=7, total=16, stage="entrances"):
    return {"phase": "premiere", "week": 1, "beatSeq": 9, "premiere": {"entrance": {"stage": stage, "index": index, "total": total, "justArrived": {"id": "npc:7", "name": name}}}}


def _quiet(monkeypatch):
    sig = {"week": 1, "phase": "premiere", "pending": None, "hoh": None, "noms": [], "vetoHolder": None, "vetoUsed": False, "evicted": 0, "finished": False}
    ch._LAST_BEAT_SIG[_USER] = dict(sig)

    async def fake_capture(user=None):
        return dict(sig)
    monkeypatch.setattr(ch, "_capture_beat_signature", fake_capture)
    ch._CEREMONY_UNVOICED.clear()
    ch._DESYNC_REGROUND.pop(_USER, None)


def test_the_framing_remembers_the_arrival_it_must_see_voiced(monkeypatch):
    _quiet(monkeypatch)
    ch.note_premiere_turn(_USER, _state("Houseguest Seven Alpha"))
    note = ch._CEREMONY_UNVOICED.get(ch._desync_key(_USER)) or {}
    assert note.get("names") == ["Houseguest Seven Alpha"]
    assert "7 of 16" in note.get("label", "")


def test_a_reply_that_never_names_the_arrival_regrounds_the_next_turn(monkeypatch):
    _quiet(monkeypatch)
    ch.note_premiere_turn(_USER, _state("Houseguest Seven Alpha"))
    _run(ch.record_post_turn_desync_check(_USER, "The doors part again. Someone new stands in the light, a duffel over one shoulder, and the room turns to look."))
    seg = ch._DESYNC_REGROUND.get(_USER) or ""
    assert "RE-GROUND ON THE CEREMONY" in seg and "Houseguest Seven Alpha" in seg


def test_a_reply_that_names_the_arrival_by_first_or_full_name_queues_nothing(monkeypatch):
    for reply in ("Houseguest Seven Alpha steps through the doors and waves.", "The doors part. Alpha steps in, duffel first."):
        _quiet(monkeypatch)
        ch.note_premiere_turn(_USER, _state("Houseguest Seven Alpha"))
        _run(ch.record_post_turn_desync_check(_USER, reply))
        assert _USER not in ch._DESYNC_REGROUND, reply


def test_no_arrival_no_note_and_the_toast_stage_is_untouched(monkeypatch):
    _quiet(monkeypatch)
    ch.note_premiere_turn(_USER, {"phase": "premiere", "week": 1, "premiere": {"entrance": {"stage": "entrances", "index": 1, "total": 16}}})
    assert ch._desync_key(_USER) not in ch._CEREMONY_UNVOICED, "the player's own entrance has no justArrived"
    ch.note_premiere_turn(_USER, _state("Houseguest Seven Alpha", stage="toast"))
    assert ch._desync_key(_USER) not in ch._CEREMONY_UNVOICED, "only the entrances stage is paired"


def test_a_malformed_premiere_view_is_ignored(monkeypatch):
    _quiet(monkeypatch)
    ch.note_premiere_turn(_USER, {"phase": "premiere", "premiere": {"entrance": {"stage": "entrances", "justArrived": "not-a-dict"}}})
    ch.note_premiere_turn(_USER, None)
    assert ch._desync_key(_USER) not in ch._CEREMONY_UNVOICED

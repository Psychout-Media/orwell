"""ORW-1130 / ORW-1129 / ORW-1132 - Ryne's prod premiere, 2026-11-28 (session 9faff772).
ORW-1130: one reply voiced 14 toasts while the engine had released two, and every later message re-released the next pair, which toasted again. The front end now reads which houseguests a reply showed GIVING
their toast and hands those names to the engine on the next release (`toastVoiced`), so nobody is released twice.
ORW-1129: the player's own slot is released alone; once a reply has invited it, the player's next message is their toast (or their pass) and the circle moves on.
ORW-1132: the circle closed silently and the house drifted off; the close now carries the host's call that opens the bedrooms. Roles only; no model."""
import asyncio
import importlib

import pytest

ch = importlib.import_module("routes.chat_helpers")
al = importlib.import_module("src.agent_loop")
oe = importlib.import_module("src.orwell_engine")

USER = "u-orw1130"


@pytest.fixture(autouse=True)
def _clean():
    stores = [ch._ARRIVALS_NAMED, ch._ARRIVALS_FRAMED, ch._ARRIVAL_VOICE_HOLDS, ch._SCHEDULE_STEER, ch._CEREMONY_UNVOICED, ch._PREMIERE_ENTRANCE_STAGE, ch._PRE_RESOLVED_ADVANCE,
              al._TURNS_SINCE_PROGRESS, ch._PREMIERE_RELEASED_THIS_TURN, ch._TOAST_BATCH_NAMED, ch._PREMIERE_TOAST_SPEAKERS, ch._ENTRANCE_FRAMES, oe._ENTRANCE_VOICED, ch._TOAST_VOICED]
    for d in stores:
        d.clear()
    yield
    for d in stores:
        d.clear()


# Lines in the shape of the 11-28 transcript (invented names): toasts introduce the speaker by their own first name; reactions do not.
REPLY = "\n\n".join([
    '@[Alpha Stone] — "Alpha. Anchorage." The pause after it is a beat too long.',
    '@[Bravo Reyes] — "Okay — I\'ll go, because if I don\'t go first I\'ll think about it all night. I\'m Bravo. Wapakoneta, Ohio."',
    '@[Charlie Park] — "Charlie Park. Houston, Texas." He lifts his glass.',
    '@[Delta Moss] — "Rhino!" Delta is grinning at you over the rim.',
    '@[Echo Lane] — "It\'s never about the towels." Echo says it easily.',
])


def test_toasts_voiced_in_reads_toasts_not_reactions():
    assert ch.toasts_voiced_in(REPLY) == ["Alpha Stone", "Bravo Reyes", "Charlie Park"]
    assert ch.toasts_voiced_in("") == []
    assert ch.toasts_voiced_in('@[Foxtrot Hale] — "Name\'s Foxtrot, and I fix bikes."') == ["Foxtrot Hale"]


def test_note_premiere_narration_remembers_toasts_only_in_the_toast_stage():
    key = ch._runway_key(USER)
    ch._PREMIERE_ENTRANCE_STAGE[key] = "entrances"
    ch.note_premiere_narration(USER, REPLY)
    assert not ch._TOAST_VOICED.get(key)
    ch._PREMIERE_ENTRANCE_STAGE[key] = "toast"
    ch.note_premiere_narration(USER, REPLY)
    assert ch._TOAST_VOICED[key] == {"Alpha Stone", "Bravo Reyes", "Charlie Park"}


def test_the_players_own_slot_counts_as_voiced_once_a_reply_has_invited_it():
    key = ch._runway_key(USER)
    ent = {"stage": "toast", "speakers": [{"id": "me", "name": "Player", "isPlayer": True}], "toastRemaining": 3}
    assert ch._note_entrance_frame(USER, key, "toast", ent) is False  # the invitation turn
    assert ch._note_entrance_frame(USER, key, "toast", ent) is True   # the player's next message: their toast, the circle moves on


def _board(entrance):
    return {"phase": "premiere", "pending": None, "premiere": {"entrance": entrance}}


def test_the_release_hands_the_engine_every_toast_already_shown(monkeypatch):
    seen = {}

    async def advance_game(**kw):
        seen.update(kw)
        return {"event": {"beat": "premiere-toast", "detail": {"speakers": [{"id": "x", "name": "Golf Ames"}]}}}

    after = _board({"stage": "toast", "index": 16, "total": 16, "speakers": [{"id": "x", "name": "Golf Ames"}], "toastRemaining": 2})

    async def fetch(user, retry=False):
        return after

    monkeypatch.setattr(oe, "advance_game", advance_game)
    monkeypatch.setattr(ch, "_fetch_game_state", fetch)
    key = ch._runway_key(USER)
    before = _board({"stage": "toast", "index": 16, "total": 16})  # no batch on the board yet: the release is due
    ch.note_premiere_turn(USER, before)
    ch._TOAST_VOICED[key] = {"Alpha Stone", "Bravo Reyes"}
    asyncio.run(ch.maybe_release_premiere_arrival(USER, before, retry=False, player_msg="cheers everyone"))
    assert seen.get("toast_voiced") == ["Alpha Stone", "Bravo Reyes"]


def test_the_close_carries_the_hosts_call_that_opens_the_bedrooms(monkeypatch):
    async def advance_game(**kw):
        return {"event": {"beat": "premiere-toast", "content": "The champagne toast ends", "detail": {"speakers": [], "closed": True}}}

    async def fetch(user, retry=False):
        return _board({"stage": "done", "index": 16, "total": 16})

    monkeypatch.setattr(oe, "advance_game", advance_game)
    monkeypatch.setattr(ch, "_fetch_game_state", fetch)
    key = ch._runway_key(USER)
    before = _board({"stage": "toast", "index": 16, "total": 16})
    ch.note_premiere_turn(USER, before)
    asyncio.run(ch.maybe_release_premiere_arrival(USER, before, retry=False, player_msg="it's a date"))
    steer = ch._SCHEDULE_STEER.get(key, "")
    assert "THE CHAMPAGNE CIRCLE HAS JUST CLOSED" in steer
    assert "bedrooms are open" in steer

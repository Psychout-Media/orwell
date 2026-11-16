"""Review of #2630: the bedtime note names the ENGINE's clock even though the engine's turnIn result carries no clockLabel (it is read fresh from the game state). Roles only."""
import asyncio
import json

from src import agent_loop as al

_TURN_IN = json.dumps({"event": None, "status": {"beatSeq": 4, "week": 1, "phase": "hoh-competition", "timeOfDay": "morning", "dayNumber": 2}})


def _run(c):
    return asyncio.get_event_loop().run_until_complete(c)


def test_the_note_names_the_engine_clock_read_from_the_game_state():
    async def state():
        return {"clockLabel": "4:15am, Day 2", "earlyMorning": True}
    out = _run(al._turn_in_output_with_clock(_TURN_IN, state))
    assert json.loads(out)["status"]["clockLabel"] == "4:15am, Day 2"
    note = al._bedtime_direct_note(out)
    assert "4:15am, Day 2" in note or "early morning" in note.lower()
    assert "4:15am" in al._bedtime_clock_note(out) or "early" in al._bedtime_clock_note(out).lower()
    plain = al._bedtime_clock_note(_TURN_IN)
    assert plain == al._BEDTIME_DIRECT_NOTE, "without the label the plain note is all it can say (the bug)"


def test_a_label_already_present_is_left_alone_and_a_failing_read_fails_open():
    has = json.dumps({"status": {"clockLabel": "9:00am, Day 3"}})

    async def boom():
        raise RuntimeError("engine down")
    assert _run(al._turn_in_output_with_clock(has, boom)) == has
    assert _run(al._turn_in_output_with_clock(_TURN_IN, boom)) == _TURN_IN


def _screen(monkeypatch, sentence, status, state):
    from routes import chat_helpers as ch
    from src import orwell_engine as oe
    stashed: list = []

    async def fake_status(user=None):
        return dict(status)

    async def fake_state(user=None):
        return dict(state)
    monkeypatch.setattr(oe, "game_status", fake_status)
    monkeypatch.setattr(oe, "get_game_state", fake_state)
    monkeypatch.setattr(ch, "_stash_overclaim_reground", lambda u, d: stashed.append(d))
    ok = asyncio.get_event_loop().run_until_complete(ch.screen_streamed_unbacked_morning("u", sentence))
    return ok, stashed


def test_a_pre_dawn_morning_claim_after_an_early_bed_is_re_grounded_without_a_bedtime_instruction(monkeypatch):
    """The player already turned in and woke at 4:15am (the engine bands that 'morning'): the re-ground states the small hours, never 'when the player goes to bed, call turnIn'."""
    ok, stashed = _screen(monkeypatch, "The next morning comes and the house wakes.", {"timeOfDay": "morning"}, {"clockLabel": "4:15am, Day 2"})
    assert ok is False and stashed
    assert "small hours" in stashed[0] and "before 7am" in stashed[0] and "turnIn" not in stashed[0]


def test_a_night_band_morning_claim_keeps_the_bedtime_instruction(monkeypatch):
    ok, stashed = _screen(monkeypatch, "The next morning comes and the house wakes.", {"timeOfDay": "night"}, {"clockLabel": "11:00pm, Day 1"})
    assert ok is False and "turnIn" in stashed[0]

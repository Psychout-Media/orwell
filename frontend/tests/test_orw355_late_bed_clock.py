"""ORW-355 - one rule for every night: the narration follows the engine's clock.

Live rehearsal 2026-11-14 (veto-competition, Day 4): the player said goodnight at ~8:15pm; the engine ran `turnIn` (ORW-310b direct path) and, as designed (P4d), an EVENING bed wakes at bed+8h, i.e. 4:15am (banded
"morning"). The narrator then voiced "Morning comes in bright and early ... It's 8:15 in the morning" - two false closed-set claims the old guards missed (the unbacked-morning screen only held while the band read
evening/night; the clock-statement check only matched "it's H:MM am/pm" and ran post-turn). Stubbed engine/LLM; roles only.
"""
import asyncio
import json

import pytest

pytestmark = pytest.mark.usefixtures("non_game_text_routing")

@pytest.fixture(autouse=True)
def _zero_clocks_off(monkeypatch):
    """ORW-377: these pin the PRE-zero-clocks behaviour (the engine clock quoted, the wrong-hour screen); the setting is OFF here, and ON is pinned in test_orw377_zero_clocks.py."""
    import src.settings as st
    real = st.get_setting
    monkeypatch.setattr(st, "get_setting", lambda k, d=None: False if k == "zero_clocks" else real(k, d))


PREDAWN = {"timeOfDay": "morning", "clockLabel": "4:15am, Day 4", "phase": "veto-competition"}
LIVE_TEXT = (
    "Then the lights click off in banks and the living room goes dark.\n\n"
    "Morning comes in bright and early, the way it always does in this house. It's 8:15 in the morning and the veto draw is still ahead. Nobody's been called.")


def _guard(monkeypatch, text, status):
    from src import agent_loop as al
    from src import orwell_engine as oe
    from routes import chat_helpers as ch
    stashed: list = []

    async def fake_status(user=None):
        return dict(status)

    monkeypatch.setattr(oe, "game_status", fake_status)
    monkeypatch.setattr(ch, "_stash_overclaim_reground", lambda u, d: stashed.append(d))
    out = asyncio.get_event_loop().run_until_complete(al._pre_emission_outcome_guard(text, "u"))
    return out, stashed


def test_live_state_predawn_clock_never_streams_morning_or_the_wrong_hour(monkeypatch):
    out, stashed = _guard(monkeypatch, LIVE_TEXT, PREDAWN)
    assert "Morning comes" not in out and "8:15" not in out
    assert "lights click off" in out and "Nobody's been called." in out
    assert any("4:15am, Day 4" in d for d in stashed)


def test_clock_time_wrong_hour_is_dropped_even_when_band_is_morning(monkeypatch):
    out, _ = _guard(monkeypatch, "It's 8:15 in the morning. The hall is quiet.", PREDAWN)
    assert "8:15" not in out and "The hall is quiet." in out


def test_a_second_wrong_clock_claim_in_the_same_sentence_is_held(monkeypatch):
    out, _ = _guard(monkeypatch, "It's 4:20 in the morning, but the time is 8:15 in the morning. The hall is quiet.", PREDAWN)
    assert "8:15" not in out and "The hall is quiet." in out


# Negative controls: a claim the clock backs is never touched.
@pytest.mark.parametrize("text,status", [
    ("Morning comes in bright and early, and the house stirs.", {"timeOfDay": "morning", "clockLabel": "8:00am, Day 4"}),
    ("It's 8:15 in the morning and the house is stirring.", {"timeOfDay": "morning", "clockLabel": "8:10am, Day 4"}),
    ("It's 4:15 in the morning, and every houseguest has turned in.", PREDAWN),
    ("It's 8:15 in the evening and the house is loud.", {"timeOfDay": "night", "clockLabel": "8:10pm, Day 3"}),
    ("She says it's 8:15 in the morning when you wake her... if the draw runs late, she would say it's 9 in the morning.", {"timeOfDay": "morning", "clockLabel": "8:10am, Day 4"}),
])
def test_backed_or_hypothetical_time_claims_stream_untouched(monkeypatch, text, status):
    out, stashed = _guard(monkeypatch, text, status)
    assert out == text and not stashed


def test_clock_screen_fails_open(monkeypatch):
    from routes import chat_helpers as ch
    from src import orwell_engine as oe

    async def boom(user=None):
        raise RuntimeError("engine down")

    monkeypatch.setattr(oe, "game_status", boom)
    assert asyncio.get_event_loop().run_until_complete(ch.screen_streamed_clock_time("u", "It's 8:15 in the morning.")) is True


def test_direct_turn_in_note_quotes_the_engine_clock():
    from src import agent_loop as al
    out = json.dumps({"status": {"timeOfDay": "morning", "clockLabel": "4:15am, Day 4"}})
    note = al._bedtime_direct_note(out)
    assert "4:15am, Day 4" in note and "before 7am" in note and note.startswith(al._BEDTIME_DIRECT_NOTE)
    assert al._bedtime_direct_note("not json") == al._BEDTIME_DIRECT_NOTE
    assert al._bedtime_direct_note(json.dumps({"timeOfDay": "morning"})) == al._BEDTIME_DIRECT_NOTE


def test_the_bed_belt_still_fires_at_night_and_holds_morning_and_afternoon():
    from src import agent_loop as al
    kw = dict(player_text="It's late and I'm exhausted. I say goodnight and go to bed.", tools_sent=["turnIn"])
    assert al._forced_tool_choice_for_bedtime(set(), status={"timeOfDay": "night", "started": True}, **kw) is not None
    for tod in ("morning", "afternoon"):
        assert al._forced_tool_choice_for_bedtime(set(), status={"timeOfDay": tod, "started": True}, **kw) is None
    # a mention of bed that is not going to bed is never forced
    assert al._forced_tool_choice_for_bedtime(
        set(), player_text="I ask her whether she is going to bed.", status={"timeOfDay": "night"}, tools_sent=["turnIn"]) is None


def test_orw382_the_day_in_review_reaches_the_narrator_on_a_direct_turn_in():
    """ORW-382 (Ryne, 11-15: no day-in-review at the Day-1 bedtime): the engine appends `dailyRecap` LAST in the pretty-printed turnIn result and the old 4000-char cut dropped it. The tool message now LEADS with
    the recap, and the production note tells the narrator to voice it (only when it has something in it)."""
    import json
    from src import agent_loop as al
    big_status = {"started": True, "pad": ["x" * 80 for _ in range(80)]}
    full = json.dumps({"started": True, "status": big_status, "dailyRecap": {"day": 1, "highlights": [], "surfaced": [], "yourDay": ["a toast"]}}, indent=2)
    assert len(full) > 4000 and '"dailyRecap"' not in full[:4000]  # red on the old cut
    msg = al._bedtime_tool_message(full)
    assert msg.startswith('{"dailyRecap"') and "a toast" in msg
    # ORW-1165: the recap is shown as its own message, so the narrator is told it is already shown and to open on the morning (the recap still reaches it as context)
    assert "dailyRecap" in al._bedtime_direct_note(full) and "already shown" in al._bedtime_direct_note(full) and "open on the new morning" in al._bedtime_direct_note(full).lower()
    empty = json.dumps({"dailyRecap": {"day": 1, "highlights": [], "surfaced": []}})
    assert al._bedtime_direct_note(empty) == al._BEDTIME_DIRECT_NOTE  # an empty recap: nothing to voice, never invent
    assert al._bedtime_tool_message("not json") == "not json"

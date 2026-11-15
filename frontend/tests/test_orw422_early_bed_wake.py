"""ORW-422 - an early bed wakes the player ALONE in the dark early morning with the house asleep (engine: wake = min(8am, bed+8h)); narration must never say the house is up. Stubbed engine; roles only."""
import asyncio
import json

import pytest

pytestmark = pytest.mark.usefixtures("non_game_text_routing")

EARLY = {"timeOfDay": "late-night", "earlyMorning": True, "clockLabel": "4:10am, Day 3", "asleep": ["a", "b"]}
EIGHT = {"timeOfDay": "morning", "clockLabel": "8:00am, Day 3", "asleep": []}


def _note(label, zc):
    import src.settings as st
    from src import agent_loop as al
    real = st.get_setting
    st.get_setting = lambda k, d=None: zc if k == "zero_clocks" else real(k, d)
    try:
        return al._bedtime_direct_note(json.dumps({"status": {"timeOfDay": "morning", "clockLabel": label}}))
    finally:
        st.get_setting = real


@pytest.mark.parametrize("zc", [True, False])
def test_early_wake_note_says_alone_dark_asleep_no_clock(zc):
    n = _note("4:10am, Day 3", zc)
    assert "ALONE" in n and "dark" in n and "asleep" in n and "never write" in n
    assert "4:10" not in n.split("The player went to bed early")[1].split("never a clock time.")[0]
    if zc:
        assert "4:10" not in n


def test_normal_wake_and_non_bed_unchanged():
    from src import agent_loop as al
    assert "ALONE" not in _note("8:00am, Day 3", True)
    assert al._bedtime_direct_note("not json") == al._BEDTIME_DIRECT_NOTE


def _screen(monkeypatch, text, status):
    from src import orwell_engine as oe
    from routes import chat_helpers as ch
    stashed = []

    async def fake_status(user=None):
        return dict(status)

    monkeypatch.setattr(oe, "game_status", fake_status)
    monkeypatch.setattr(ch, "_stash_overclaim_reground", lambda u, d: stashed.append(d))
    return asyncio.get_event_loop().run_until_complete(ch.screen_streamed_house_awake("u", text)), stashed


@pytest.mark.parametrize("text", [
    "You wake to grey light, and the house is up and moving.",
    "A houseguest leans in. \"Morning. I know it's early,\" she says.",
    "Everyone is already awake in the kitchen.",
])
def test_held_at_early_morning(monkeypatch, text):
    ok, stashed = _screen(monkeypatch, text, EARLY)
    assert ok is False and stashed and "asleep" in stashed[0]


@pytest.mark.parametrize("text,status", [
    ("The house is up and moving.", EIGHT),
    ("\"Morning,\" she says.", {"timeOfDay": "morning", "clockLabel": "9:30am, Day 3"}),
    ("The house is asleep around you.", EARLY),
    ("The house is not up yet; the dark is total.", EARLY),
    ("She will say the house is up when the call comes.", EARLY),
    ("You lie awake and listen to the vents.", EARLY),
    ("The house is up and moving.", {"clockLabel": "4:10am, Day 3", "asleep": []}),
])
def test_not_held(monkeypatch, text, status):
    ok, stashed = _screen(monkeypatch, text, status)
    assert ok is True and not stashed


def test_fails_open(monkeypatch):
    from routes import chat_helpers as ch
    from src import orwell_engine as oe

    async def boom(user=None):
        raise RuntimeError("down")

    monkeypatch.setattr(oe, "game_status", boom)
    assert asyncio.get_event_loop().run_until_complete(ch.screen_streamed_house_awake("u", "The house is up and moving.")) is True


def test_orw437_the_screen_reads_the_clock_from_the_state_projection_when_status_has_none(monkeypatch):
    """review of #2735: the real `gameStatus` has no `clockLabel` and bands a 4am wake "morning" without `earlyMorning`."""
    from src import orwell_engine as oe
    from routes import chat_helpers as ch
    stashed = []

    async def real_shaped_status(user=None):
        return {"timeOfDay": "morning", "asleep": ["a"]}  # no clockLabel, no earlyMorning

    async def state(user=None, timeout=None):
        return {"clockLabel": "4:10am, Day 3", "asleep": ["a"]}

    monkeypatch.setattr(oe, "game_status", real_shaped_status)
    monkeypatch.setattr(oe, "get_game_state", state)
    monkeypatch.setattr(ch, "_stash_overclaim_reground", lambda u, d: stashed.append(d))
    run = asyncio.get_event_loop().run_until_complete
    assert run(ch.screen_streamed_house_awake("u", "Everyone is already awake in the kitchen.")) is False and stashed


def test_orw437_a_standalone_house_awake_claim_is_held_by_the_pre_emission_guard(monkeypatch):
    """review of #2735: the fast path used to return before the house-awake screen for a sentence with no other claim."""
    from src import agent_loop as al
    from routes import chat_helpers as ch
    seen = []

    async def held(user, sentence):
        seen.append(sentence)
        return False

    monkeypatch.setattr(ch, "screen_streamed_house_awake", held)
    out = asyncio.get_event_loop().run_until_complete(al._pre_emission_outcome_guard("Everyone is already awake in the kitchen.", "u"))
    assert seen and out == ""


def _real_shaped(monkeypatch, clock="4:10am, Day 3"):
    from src import orwell_engine as oe
    from routes import chat_helpers as ch
    stashed = []

    async def status(user=None):
        return {"timeOfDay": "morning", "asleep": []}  # the real gameStatus: no clockLabel

    async def state(user=None, timeout=None):
        return {"clockLabel": clock}

    monkeypatch.setattr(oe, "game_status", status)
    monkeypatch.setattr(oe, "get_game_state", state)
    monkeypatch.setattr(ch, "_stash_overclaim_reground", lambda u, d: stashed.append(d))
    return ch, stashed, asyncio.get_event_loop().run_until_complete


def test_orw437_unbacked_morning_screen_reads_the_clock_from_the_state_projection(monkeypatch):
    ch, stashed, run = _real_shaped(monkeypatch)
    assert run(ch.screen_streamed_unbacked_morning("u", "Morning arrives with a clatter from the kitchen.")) is False and stashed
    ch, stashed, run = _real_shaped(monkeypatch, "9:30am, Day 3")
    assert run(ch.screen_streamed_unbacked_morning("u", "Morning arrives with a clatter from the kitchen.")) is True and not stashed


def test_orw437_in_the_clock_screen_reads_the_clock_from_the_state_projection(monkeypatch):
    ch, stashed, run = _real_shaped(monkeypatch)
    assert run(ch.screen_streamed_clock_time("u", "It's 9:30 in the morning.")) is False and stashed
    ch, stashed, run = _real_shaped(monkeypatch)
    assert run(ch.screen_streamed_clock_time("u", "It's 4:15 in the morning.")) is True and not stashed

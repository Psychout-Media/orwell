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

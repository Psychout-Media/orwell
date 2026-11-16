"""ORW-524 - at 4:41-4:56am with every houseguest asleep the narrator wrote gold light, a fully lit room and an awake house. Closed-set clock claims, held before the 8am wake. Stubbed engine; roles only."""
import asyncio

import pytest

pytestmark = pytest.mark.usefixtures("non_game_text_routing")

SMALL_HOURS = {"timeOfDay": "late-night", "earlyMorning": True, "clockLabel": "4:46am, Day 2", "awake": [], "asleep": ["a", "b", "c"]}
EIGHT_AWAKE = {"timeOfDay": "morning", "clockLabel": "8:30am, Day 2", "awake": ["a", "b"], "asleep": []}


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
    "The grey light gone thin and gold.",
    "The room's fully lit now, gold through the blinds.",
    "The light's too far along - gold now, not grey.",
    "Golden light spills across the bed.",
])
def test_gold_or_bright_dawn_light_is_held_before_the_wake(monkeypatch, text):
    ok, stashed = _screen(monkeypatch, text, SMALL_HOURS)
    assert ok is False and stashed and "small hours" in stashed[0]


@pytest.mark.parametrize("text", [
    "Fifteen other people are already awake in it.",
    "Fifteen people up and moving past that door.",
    "The house is properly awake.",
    "The house is just beginning to remember itself.",
    "Everybody is up and about by now.",
])
def test_an_awake_house_claim_is_held_while_all_are_asleep(monkeypatch, text):
    ok, stashed = _screen(monkeypatch, text, SMALL_HOURS)
    assert ok is False and stashed and "asleep" in stashed[0]


@pytest.mark.parametrize("text", [
    "The dark is still thick, and the glass doors are flat black.",
    "The house is asleep.",
    "A thin line of grey sits under the door.",
    "Nobody is awake yet.",
    "Fifteen people are asleep down the hall.",
    "No gold light yet; the blinds are black.",
    "You are wide awake and listening to the vents.",
    "The light is not gold, not yet.",
])
def test_correct_small_hours_description_passes(monkeypatch, text):
    ok, stashed = _screen(monkeypatch, text, SMALL_HOURS)
    assert ok is True and not stashed


@pytest.mark.parametrize("text", [
    "The room is fully lit now, gold through the blinds.",
    "Fifteen people up and moving past that door.",
    "The house is properly awake.",
])
def test_a_real_morning_after_the_wake_passes(monkeypatch, text):
    ok, stashed = _screen(monkeypatch, text, EIGHT_AWAKE)
    assert ok is True and not stashed


def test_a_golden_object_is_not_dawn_light(monkeypatch):
    ok, _ = _screen(monkeypatch, "A golden retriever statue sits by the window.", SMALL_HOURS)
    assert ok is True

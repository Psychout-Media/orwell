"""ORW-474 (Kevin with Ryne, "the clock wins") - a wake before the 8am house wake-up is the small hours: no morning-light / daylight claim, shown AND stored; at 8am+ it still reads as morning. Stubbed engine; roles only."""
import asyncio
import json

import pytest

pytestmark = pytest.mark.usefixtures("non_game_text_routing")

EARLY = {"timeOfDay": "morning", "earlyMorning": True, "clockLabel": "4:15am, Day 3", "asleep": ["a", "b"]}
EARLY_NOBODY_ASLEEP = {"clockLabel": "4:15am, Day 3", "asleep": []}
EIGHT = {"timeOfDay": "morning", "clockLabel": "8:05am, Day 3", "asleep": []}
WAKE = "You wake to the first grey morning light, alone. "


def _loop(monkeypatch, raw, status):
    from src import agent_loop as al
    from src import orwell_engine as oe
    from routes import chat_helpers as ch
    stashed = []

    async def fake_status(user=None):
        return dict(status)

    monkeypatch.setattr(oe, "game_status", fake_status)
    monkeypatch.setattr(ch, "_stash_overclaim_reground", lambda u, d: stashed.append(d))
    g, _ = asyncio.get_event_loop().run_until_complete(al._guard_stream_chunk(raw, "u", ooc_open="", scene_broken=False, emitted_visible=True, cutaway_emitted=False))
    return g.text, al._apply_mirror_ops(raw, g.mirror_ops), stashed


@pytest.mark.parametrize("status", [EARLY, EARLY_NOBODY_ASLEEP])
@pytest.mark.parametrize("bad", [WAKE, "Daylight leaks in. ", "The sun is already up. ", "Dawn breaks over the yard. ", "A pale golden light fills the room as you wake. "])
def test_small_hours_wake_drops_morning_light_shown_and_stored(monkeypatch, status, bad):
    raw = "The kettle ticked. " + bad + "Rain tapped the glass. "
    shown, stored, stashed = _loop(monkeypatch, raw, status)
    assert stashed
    for t in (shown, stored):
        assert "light" not in t.lower().replace("daylight", "light") or "The kettle" in t
        for w in ("morning light", "Daylight", "sun is", "Dawn", "golden"):
            assert w not in t
        assert "The kettle ticked." in t and "Rain tapped the glass." in t
    assert stored == shown


def test_wake_at_or_after_house_wake_still_reads_as_morning(monkeypatch):
    shown, stored, stashed = _loop(monkeypatch, WAKE, EIGHT)
    assert "morning light" in shown and "morning light" in stored and not stashed


def test_light_claim_reground_names_the_small_hours(monkeypatch):
    from routes import chat_helpers as ch
    from src import orwell_engine as oe
    stashed = []

    async def fake_status(user=None):
        return dict(EARLY_NOBODY_ASLEEP)

    monkeypatch.setattr(oe, "game_status", fake_status)
    monkeypatch.setattr(ch, "_stash_overclaim_reground", lambda u, d: stashed.append(d))
    assert asyncio.get_event_loop().run_until_complete(ch.screen_streamed_house_awake("u", WAKE)) is False
    assert stashed and "small hours" in stashed[0]


@pytest.mark.parametrize("text", [
    "The house is dark and quiet. ",
    "A pale light from the hallway lies across the floor. ",
    "\"We will talk tomorrow morning,\" she says. ",
    "You hope the morning light will come soon. ",
    "The sun has not come up yet. ",
])
def test_negative_set_passes_at_4am(monkeypatch, text):
    shown, stored, stashed = _loop(monkeypatch, text, EARLY)
    assert shown == text and stored == text and not stashed


def test_post_turn_in_block_says_small_hours_not_morning():
    from src import agent_loop as al
    out = al._post_turn_in_asleep_block(json.dumps({"status": {"timeOfDay": "morning", "earlyMorning": True, "clockLabel": "4:15am, Day 3", "asleep": [{"name": "A"}]}}))
    assert "small hours" in out and "NO morning light" in out and "it is now morning" not in out
    ok = al._post_turn_in_asleep_block(json.dumps({"status": {"timeOfDay": "morning", "clockLabel": "8:00am, Day 3", "asleep": []}}))
    assert "it is now morning" in ok and "small hours" not in ok

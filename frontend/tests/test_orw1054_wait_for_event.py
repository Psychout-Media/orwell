"""ORW-1054: a wait whose end is the next scheduled event runs to it in ONE engine call (until_event). Roles only."""
import asyncio
import importlib

ch = importlib.import_module("routes.chat_helpers")


def test_waiting_for_production_or_the_next_event_is_an_event_wait():
    for msg in ("I hang out until production calls the next event.",
                "I chill in the living room until the nominations ceremony.",
                "I wait around for the veto competition."):
        assert ch._waits_for_event(msg), msg


def test_a_stated_length_or_a_plain_chat_is_not():
    for msg in ("I hang out for a while.", "I wait. What time is it?", "Let's chat about the vote."):
        assert not ch._waits_for_event(msg), msg


def test_maybe_hang_out_passes_until_event_only_for_an_event_wait(monkeypatch):
    seen = []

    async def fake_hang_out(**kw):
        seen.append(kw)
        return {"ok": True, "stopReason": "event-due", "minutes": 90, "beatSeq": 1}

    eng = importlib.import_module("src.orwell_engine")
    monkeypatch.setattr(eng, "hang_out", fake_hang_out)
    gs = {"started": True, "pending": None}
    assert asyncio.run(ch.maybe_hang_out("u1054", gs, "I hang out until production calls the next event."))
    assert seen[-1].get("until_event") is True
    assert asyncio.run(ch.maybe_hang_out("u1054", gs, "I hang out for an hour."))
    assert "until_event" not in seen[-1] and seen[-1].get("max_minutes") == 60

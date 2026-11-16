"""ORW-510: the front-end half of the live narration-use record relays the visible narration, nothing else, and fails soft."""
import asyncio
import logging

from src import orwell_narration_use as nu

LONG = "You walk into the kitchen. Someone tucks her hair behind an ear. The house hums quietly around you."


def test_capture_relays_exactly_the_text_and_logs_the_season_line(caplog):
    sent = []

    async def write(text):
        sent.append(text)
        return {"recorded": True, "sentences": 3, "seasonLine": "[narration-repetition] season line: turns=1 sentences=3"}

    with caplog.at_level(logging.INFO):
        out = asyncio.run(nu.capture("  " + LONG + "  ", write))
    assert sent == [LONG]
    assert out and out.startswith("[narration-repetition] season line:")
    assert any("[narration-repetition] season line" in r.message for r in caplog.records)


def test_capture_cuts_to_the_engine_bound_and_skips_one_liners():
    sent = []

    async def write(text):
        sent.append(text)
        return {"recorded": False, "reason": "off"}

    assert asyncio.run(nu.capture("Ok.", write)) is None and sent == []
    assert asyncio.run(nu.capture("word. " * 5000, write)) is None
    assert len(sent[0]) == nu.MAX_TEXT_CHARS


def test_capture_is_quiet_when_the_engine_refuses():
    async def write(text):
        return {"recorded": False, "reason": "no-game"}

    assert asyncio.run(nu.capture(LONG, write)) is None


def test_after_turn_never_raises(monkeypatch):
    import src.orwell_engine as oe

    async def boom(text, user=None):
        raise RuntimeError("engine down")

    monkeypatch.setattr(oe, "record_narration_use", boom)
    monkeypatch.setattr("src.orwell_show_brief.show_brief_enabled", lambda: True)
    assert asyncio.run(nu.after_turn(LONG, "u510")) is None


def test_after_turn_is_off_with_the_brief(monkeypatch):
    import src.orwell_engine as oe
    called = []

    async def rec(text, user=None):
        called.append(text)
        return {"recorded": True}

    monkeypatch.setattr(oe, "record_narration_use", rec)
    monkeypatch.setattr("src.orwell_show_brief.show_brief_enabled", lambda: False)
    assert asyncio.run(nu.after_turn(LONG, "u510")) is None and called == []

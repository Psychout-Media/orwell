"""ORW-148 part C - the champagne jump. The engine's premiereIntros reports complete/remaining:[] while entrances are
still being staged, so the narrator jumped to the toast. FE-side fixes: the tool wrapper annotates the output while the
entrance stage is live, the identity note stops describing the champagne circle, and the tutorial card describes
arrivals one at a time. (Engine-side premiereIntros fix is a follow-up.)"""
import asyncio
import importlib
import json
import re
from pathlib import Path

ch = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")
ti = importlib.import_module("src.tool_implementations")

ROOT = Path(__file__).resolve().parents[1]


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _intros(monkeypatch, payload):
    async def fake(user=None):
        return payload
    monkeypatch.setattr(orwell_engine, "premiere_intros", fake)


def test_intros_output_notes_entrances_in_progress(monkeypatch):
    u = "orw148-c"
    ch._PREMIERE_ENTRANCE_STAGE.clear()
    _intros(monkeypatch, {"complete": True, "remaining": []})
    ch.note_premiere_turn(u, {"phase": "premiere", "premiere": {"entrance": {"stage": "entrances"}}})
    out = _run(ti.do_premiere_intros("{}", owner=u))["output"]
    assert '"complete": true' in out  # engine payload untouched
    assert "STILL IN PROGRESS" in out and "champagne toast has NOT happened" in out
    ch._PREMIERE_ENTRANCE_STAGE.clear()


def test_intros_output_has_no_note_outside_entrances(monkeypatch):
    u = "orw148-c-off"
    ch._PREMIERE_ENTRANCE_STAGE.clear()
    _intros(monkeypatch, {"complete": True, "remaining": []})
    ch.note_premiere_turn(u, {"phase": "premiere", "premiere": {"entrance": {"stage": "done"}}})
    out = _run(ti.do_premiere_intros("{}", owner=u))["output"]
    assert "STILL IN PROGRESS" not in out
    assert json.loads(out)["complete"] is True


def test_identity_note_does_not_describe_the_champagne_circle():
    note = ch.PREMIERE_IDENTITY_ON_FILE_NOTE.lower()
    assert "champagne circle" not in note
    assert "on file" in note and "greet" in note


def test_tutorial_card_describes_arrivals_one_at_a_time():
    js = (ROOT / "static" / "js" / "orwellPremiereTutorial.js").read_text()
    rendered = "".join(re.findall(r"(?:textContent|innerHTML)\s*[+=]=?\s*[^;]+;", js))
    assert "one at a time" in rendered
    assert "right there" not in rendered
    assert "step into the champagne circle" not in js

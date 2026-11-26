"""ORW-999 (live): a houseguest who is not in the player's room was still heard TALKING. The presence wall dropped the sentence that placed them, but the quoted line that followed (a new sentence,
after a pronoun, or with the name after the quote) stayed on screen. BEHAVIOURAL on `screen_presence_wall` with a stubbed board. Roles only: Ana is in the room, Levi is not.
"""
import asyncio

import pytest

from routes import chat_helpers
from test_a2_presence_wall import _async, _house, _state

_BOARD = _state("bedroom-a", present=["Ana Reed"], house=_house(active=["Ana Reed", "Levi Mock"]))


def _wall(monkeypatch, *chunks):
    from src import orwell_engine
    monkeypatch.setattr(orwell_engine, "get_game_state", lambda user=None: _async(_BOARD))
    carry: dict = {}
    loop = asyncio.new_event_loop()
    try:
        return "".join(loop.run_until_complete(chat_helpers.screen_presence_wall("orw999", c, carry=carry)) for c in chunks)
    finally:
        loop.close()


@pytest.mark.parametrize("text,line", [
    ('Levi Mock drops onto the bed. "You can have the window," he says.\n\nAna Reed nods.', "window"),
    ('Levi Mock drops onto the bed. "You can have the window."\n\nAna Reed nods.', "window"),
    ('Levi Mock grins. He shrugs. "Seriously, take it."\n', "Seriously"),
    ('"Take it," says Levi. Ana Reed laughs.', "Take it"),
    ('Levi folds his arms. "I am not moving." "Not tonight."\n', "Not tonight"),
])
def test_an_absent_houseguests_speech_is_dropped(monkeypatch, text, line):
    assert line not in _wall(monkeypatch, text)


def test_it_holds_across_streamed_chunks(monkeypatch):
    out = _wall(monkeypatch, "Levi Mock drops onto the bed.", ' "You can have the window."')
    assert "window" not in out


@pytest.mark.parametrize("text", [
    'Ana Reed asks where Levi is. "Has anyone seen him?"',
    'Levi folds his arms.\n\n"Morning," Ana Reed says.',
    'You hear Levi laughing in the next room. "Quiet in there," Ana Reed says.',
    'Ana Reed stretches. "Take the window."',
])
def test_a_present_speaker_keeps_their_words(monkeypatch, text):
    out = _wall(monkeypatch, text)
    for quoted in ("Has anyone seen him?", "Morning", "Quiet in there", "Take the window"):
        if quoted in text:
            assert quoted in out, out

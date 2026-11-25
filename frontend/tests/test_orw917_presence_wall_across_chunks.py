"""ORW-917 (Fable week-1 playtest): a reply's speaker line was cut - the bubble began "Moss." or " Brandon, Florida.\" She comes in..." with the speaker's name and the start
of their line gone. The model had written `@[Name] — "Name. Town, State." She comes in...`; the presence wall dropped the line of a houseguest the engine had not placed in the
room, but the wall runs on each STREAMED CHUNK on its own and began every chunk outside any quote. So the "drop the rest of that speaker's quote" state was lost at the chunk
boundary: the rest of the quote ("Town, State.\"") was kept in the next chunk, and its closing mark was read as an opening one. The state now carries across the round's chunks
(`carry`): a dropped line goes whole, across chunks, and the prose after its quote is kept. Roles only."""
import asyncio
import importlib

chat_helpers = importlib.import_module("routes.chat_helpers")
from src import orwell_engine

_USER = "u-orw917-wall"


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _state():
    return {"whereabouts": {"room": "kitchen", "present": [{"id": "npc:1", "name": "An Ally"}], "nearby": []},
            "house": [{"name": "An Ally", "status": "active"}, {"name": "A Newcomer", "status": "active"}]}


def _screen(monkeypatch, chunks):
    async def gs(user=None):
        return _state()
    monkeypatch.setattr(orwell_engine, "get_game_state", gs)
    carry = {}
    return [_run(chat_helpers.screen_presence_wall(_USER, c, carry=carry)) for c in chunks]


WHOLE = ('The front door goes again.\n\n@[A Newcomer] — "A Newcomer. Hometown, State. I close deals." She comes in at a pace, like the room is a list.'
         '\n\n@[An Ally] "Morning." The ally lifts a mug.')


def test_one_chunk_drops_the_whole_tagged_line(monkeypatch):
    out = "".join(_screen(monkeypatch, [WHOLE]))
    assert "A Newcomer" not in out and "Hometown" not in out and "close deals" not in out
    assert "The front door goes again." in out and '@[An Ally] "Morning."' in out


def test_split_at_the_first_sentence_the_rest_of_the_dropped_quote_never_shows(monkeypatch):
    cut = WHOLE.index(" Hometown")
    out = "".join(_screen(monkeypatch, [WHOLE[:cut], WHOLE[cut:]]))
    assert "Hometown" not in out and "close deals" not in out, f"the dropped speaker's quote leaked past the chunk boundary: {out!r}"
    assert "The front door goes again." in out and '@[An Ally] "Morning."' in out and "The ally lifts a mug." in out


def test_kept_prose_after_a_closed_quote_in_a_later_chunk_keeps_its_quote_state(monkeypatch):
    """A kept quote that closes in a later chunk is not read as a new opening (the carried state is the whole round's)."""
    text = '@[An Ally] "Morning. Coffee is on." The ally lifts a mug.\n\n@[A Newcomer] — "Hi." She waves.'
    cut = text.index(" Coffee")
    out = "".join(_screen(monkeypatch, [text[:cut], text[cut:]]))
    assert '@[An Ally] "Morning. Coffee is on." The ally lifts a mug.' in out
    assert "A Newcomer" not in out and "Hi." not in out


def test_a_carried_drop_finishes_even_when_the_next_chunk_has_nothing_to_screen(monkeypatch):
    calls = {"n": 0}

    async def gs(user=None):
        calls["n"] += 1
        return _state() if calls["n"] == 1 else {"whereabouts": {"room": "kitchen", "present": [], "nearby": []}, "house": []}
    monkeypatch.setattr(orwell_engine, "get_game_state", gs)
    carry = {}
    a = _run(chat_helpers.screen_presence_wall(_USER, 'Quiet.\n\n@[A Newcomer] — "Hi there.', carry=carry))
    b = _run(chat_helpers.screen_presence_wall(_USER, ' More of it." She waves. The kettle clicks.', carry=carry))
    assert "Newcomer" not in a + b and "More of it" not in a + b and "The kettle clicks." in b

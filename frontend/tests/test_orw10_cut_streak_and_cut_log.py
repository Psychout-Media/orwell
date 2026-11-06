"""ORW-10 items 2 and 3 (live replay 5): (2) a guard must never strand the player - after consecutive CUT turns the breaker stops accusing and queues a neutral engine-true board directive, and the
cutaway becomes a plain engine-true board line; a turn with no cut resets the streak. (3) every cut persists its text (JSONL) so a cut is diagnosable afterwards (the 00:48:07 'phantom HOH win' cut text was
never saved). Roles only."""
import asyncio
import importlib
import json

import pytest

chat_helpers = importlib.import_module("routes.chat_helpers")
_USER = "u-orw10-streak"
PHANTOM = "The feeds swing to you - you won HOH! Everyone erupts."


def _run(c):
    return asyncio.get_event_loop().run_until_complete(c)


def _sig(**o):
    b = {"week": 1, "phase": "hoh", "pending": None, "hoh": "npc:1", "hohName": "Marcus", "noms": ["npc:2", "npc:3"], "nomNames": ["Sofia", "Mario"],
         "activeNames": ["Sofia", "Mario", "Marcus", "Nina", "Sam"], "vetoHolder": "npc:4", "vetoHolderName": "Nina", "vetoUsed": False,
         "playerIsHoh": False, "playerHasVeto": False, "evicted": 0, "evictedNames": [], "finished": False, "room": "kitchen", "present": []}
    b.update(o)
    return b


@pytest.fixture(autouse=True)
def _clean(monkeypatch, tmp_path):
    for d in (chat_helpers._LAST_BEAT_SIG, chat_helpers._DESYNC_REGROUND, chat_helpers._CUT_STREAK):
        d.pop(_USER, None)
    monkeypatch.setenv("ORWELL_SCENE_CUT_LOG", str(tmp_path / "cuts.jsonl"))

    async def fake_capture(user=None):
        return _sig()
    monkeypatch.setattr(chat_helpers, "_capture_beat_signature", fake_capture)
    yield
    for d in (chat_helpers._LAST_BEAT_SIG, chat_helpers._DESYNC_REGROUND, chat_helpers._CUT_STREAK):
        d.pop(_USER, None)


def _turn(text):
    chat_helpers._LAST_BEAT_SIG[_USER] = _sig()  # a fresh baseline dict per turn, as the framing step does
    return _run(chat_helpers.screen_streamed_scene_break(_USER, text))


def test_first_cut_accuses_but_the_second_consecutive_cut_turn_goes_neutral_and_engine_true():
    d1 = _turn(PHANTOM)
    assert d1 and "HEAD OF HOUSEHOLD" in d1
    d2 = _turn(PHANTOM)
    assert d2 and "HEAD OF HOUSEHOLD" not in d2 and "Marcus" in d2 and "Sofia" in d2 and "Nina" in d2
    assert chat_helpers._DESYNC_REGROUND[_USER] == d2  # the neutral board directive REPLACES the accusation in the context
    assert chat_helpers.cut_streak(_USER) >= 2
    assert "Marcus" in chat_helpers.engine_true_line(_USER)


def test_two_chunks_of_one_turn_count_as_one_cut_turn():
    chat_helpers._LAST_BEAT_SIG[_USER] = _sig()
    _run(chat_helpers.screen_streamed_scene_break(_USER, PHANTOM))
    _run(chat_helpers.screen_streamed_scene_break(_USER, PHANTOM))
    assert chat_helpers.cut_streak(_USER) == 1


def test_a_turn_with_no_cut_resets_the_streak():
    _turn(PHANTOM)
    _turn(PHANTOM)
    assert chat_helpers.cut_streak(_USER) >= 2
    assert _turn("Sofia laughs and hands you a mug of coffee.") is None
    _turn("Nina and Sam argue quietly about the dishes.")  # next turn begins: the previous turn had no cut
    assert chat_helpers.cut_streak(_USER) == 0


def test_every_cut_persists_its_text(tmp_path):
    _turn(PHANTOM)
    rows = [json.loads(l) for l in (tmp_path / "cuts.jsonl").read_text().splitlines()]
    assert rows and rows[0]["text"] == PHANTOM and rows[0]["phase"] == "hoh" and "HEAD OF HOUSEHOLD" in rows[0]["directive"]


def test_the_cutaway_becomes_the_engine_true_line_from_the_second_cut_turn():
    agent_loop = importlib.import_module("src.agent_loop")
    chat_helpers._LAST_BEAT_SIG[_USER] = _sig()
    first = _run(agent_loop._emit_guarded_scene(PHANTOM, _USER, scene_broken=False, emitted_visible=False, cutaway_emitted=False))
    assert first.text == agent_loop._SCENE_CUTAWAY_LINE
    chat_helpers._LAST_BEAT_SIG[_USER] = _sig()  # the next turn
    second = _run(agent_loop._emit_guarded_scene(PHANTOM, _USER, scene_broken=False, emitted_visible=False, cutaway_emitted=False))
    assert second.text != agent_loop._SCENE_CUTAWAY_LINE and "Marcus" in second.text and "Nina" in second.text

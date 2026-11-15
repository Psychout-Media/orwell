"""ORW-346 - the E22 guard is for a model that SKIPPED a recordInteraction, not for a turn with nobody in the scene.

Live week (2026-11-14, real narrator): all 13 E22 firings in 43 turns were turns whose extraction answered {"withIds":[]} - the player alone in bed, or a comp/ceremony took the beat before anyone engaged.
The guard counted each as an under-call and wrote a flat participant-less "Scene (auto-recorded)" digest. Now an explicit "nobody engaged" stands the guard down (INFO, no WARN, no counter, no digest);
a REAL under-call (the extractor found someone, or failed) still fires exactly as before.
"""
import asyncio
import importlib

import pytest

chat_helpers = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")
fold_ledger = importlib.import_module("src.fold_ledger")

NARRATION = "The bedroom is dark and cool, and there is nobody in it but the player, the blinds cutting the yard lights into thin stripes. " * 3


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


@pytest.fixture(autouse=True)
def _clean():
    chat_helpers._fallback_in_flight.clear(); fold_ledger._SCENE_NOBODY.clear()
    yield
    chat_helpers._fallback_in_flight.clear(); fold_ledger._SCENE_NOBODY.clear()


def _spy_record(monkeypatch):
    calls = []

    async def rec(*a, **k):
        calls.append((a, k)); return {"ok": True}
    monkeypatch.setattr(orwell_engine, "record_interaction", rec)
    return calls


def test_extraction_found_nobody_stands_down_without_a_digest_or_a_count(monkeypatch, caplog):
    calls = _spy_record(monkeypatch)

    async def nobody(user, player_message, narration):
        fold_ledger.note_scene_nobody(user); return False
    monkeypatch.setattr(chat_helpers, "_e22_rich_extract", nobody)
    before = chat_helpers._unrecorded_turn_fallbacks
    out = _run(chat_helpers.ensure_turn_recorded("u", "I grab a snack and ask the nearest houseguest how they are holding up.", NARRATION, []))
    assert out is False and calls == []
    assert chat_helpers._unrecorded_turn_fallbacks == before
    assert "narrated with no engine write" not in caplog.text


def test_in_loop_belt_already_found_nobody_stands_down_before_any_extraction(monkeypatch):
    calls = _spy_record(monkeypatch)
    fold_ledger.note_scene_nobody("u")

    async def boom(*a, **k):
        raise AssertionError("no second extraction call")
    monkeypatch.setattr(chat_helpers, "_e22_rich_extract", boom)
    assert _run(chat_helpers.ensure_turn_recorded("u", "hello", NARRATION, [])) is False and calls == []


def test_a_real_under_call_still_fires_and_still_writes_the_floor_digest(monkeypatch, caplog):
    calls = _spy_record(monkeypatch)

    async def declined(user, player_message, narration):
        return False  # a hiccup / no model: NOT an explicit "nobody"
    monkeypatch.setattr(chat_helpers, "_e22_rich_extract", declined)
    before = chat_helpers._unrecorded_turn_fallbacks
    _run(chat_helpers.ensure_turn_recorded("u", "I press the swing vote.", NARRATION, []))
    assert chat_helpers._unrecorded_turn_fallbacks == before + 1 and len(calls) == 1
    assert "narrated with no engine write" in caplog.text


def test_a_rich_extraction_that_banked_a_scene_is_still_counted_as_an_under_call(monkeypatch):
    _spy_record(monkeypatch)

    async def banked(user, player_message, narration):
        return True
    monkeypatch.setattr(chat_helpers, "_e22_rich_extract", banked)
    before = chat_helpers._unrecorded_turn_fallbacks
    assert _run(chat_helpers.ensure_turn_recorded("u", "I pull someone aside.", NARRATION, [])) is True
    assert chat_helpers._unrecorded_turn_fallbacks == before + 1


def test_the_belt_notes_nobody_only_for_an_explicit_empty_answer():
    import inspect
    src = inspect.getsource(importlib.import_module("src.agent_loop")._auto_record_scene)
    assert "note_scene_nobody" in src and "if not _rejected_with_ids" in src

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
    chat_helpers._fallback_in_flight.clear(); fold_ledger._SCENE_NOBODY.clear(); fold_ledger.clear_all()
    yield
    chat_helpers._fallback_in_flight.clear(); fold_ledger._SCENE_NOBODY.clear(); fold_ledger.clear_all()


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


# ORW-507 (retro review of the ORW-346 change): the old source-string pin could not tell an explicit "nobody" from a malformed answer. These drive the REAL belt (`_auto_record_scene`) with a prefetched
# extraction payload and read the ledger flag the guard consumes.
_HOUSE = [{"id": "npc:1", "name": "Holder"}, {"id": "npc:2", "name": "Rival"}]
_NARRATION_SCENE = "The player sits with the houseguest at the table and talks quietly about the week ahead and who they can trust."


def _belt(raw, owner="belt-user"):
    agent_loop = importlib.import_module("src.agent_loop")
    fold_ledger._SCENE_NOBODY.clear()
    out = _run(agent_loop._auto_record_scene(_NARRATION_SCENE, "I ask how they are doing.", _HOUSE, "http://unused", "m", {}, owner, raw=raw))
    return out, fold_ledger.consume_scene_nobody(owner)


def test_an_explicit_empty_withIds_marks_the_ledger_nobody():
    out, marked = _belt('{"withIds": [], "kind": "strategy", "content": "x"}')
    assert out is False and marked is True


def test_a_malformed_or_unresolvable_answer_does_not_mark_nobody(monkeypatch):
    # a rejected id (not on the living roster) and an unparseable / withIds-less reply are NOT "nobody engaged": the E22 guard must keep its normal under-call handling
    for raw in ('{"withIds": ["npc:99"], "kind": "strategy", "content": "x"}', '{"withIds": "npc:1"}', '{"kind": "strategy", "content": "x"}', "not json at all"):
        out, marked = _belt(raw)
        assert out is False and marked is False, raw


def test_the_belt_notes_nobody_only_for_an_explicit_empty_answer():
    import inspect
    src = inspect.getsource(importlib.import_module("src.agent_loop")._auto_record_scene)
    assert "note_scene_nobody" in src and "if not _rejected_with_ids" in src


def test_a_nobody_flag_left_by_an_early_return_turn_never_silences_the_next_turn(monkeypatch):
    """ORW-481 (retro review): a turn that stands down early (here a bare OOC aside) still consumes the flag."""
    calls = _spy_record(monkeypatch)
    fold_ledger.note_scene_nobody("u")
    _run(chat_helpers.ensure_turn_recorded("u", "(( what is happening? ))", NARRATION, []))
    assert "u" not in fold_ledger._SCENE_NOBODY

    async def declined(user, player_message, narration):
        return False
    monkeypatch.setattr(chat_helpers, "_e22_rich_extract", declined)
    _run(chat_helpers.ensure_turn_recorded("u", "I press the swing vote.", NARRATION, []))
    assert len(calls) == 1


def test_orw481_an_old_requeued_fold_does_not_stand_the_guard_down(monkeypatch):
    """ORW-481 (review 4535233845): only a fold staged THIS turn stands the guard down; an older queued entry does not."""
    calls = _spy_record(monkeypatch)

    async def rich(*a, **k):
        return False
    monkeypatch.setattr(chat_helpers, "_e22_rich_extract", rich)
    fold_ledger.stage_pending_fold("u", "s", content="old", with_ids=["npc:3"], kind="bonding", consequence=None, felt_minutes=None, idempotency_key="k1")
    fold_ledger.consume_staged_this_turn("u", "s")  # that turn is over; the entry stays queued (a re-queue)
    _run(chat_helpers.ensure_turn_recorded("u", "hello", NARRATION, [], session_id="s"))
    assert calls, "the floor fold must run for a turn that staged nothing"


def test_orw481_a_stage_left_by_a_dropped_turn_does_not_leak_into_the_next_turn(monkeypatch):
    """ORW-481 (review 4582382317): a turn that staged a fold then dropped/errored before [DONE] never consumed the flag; the next turn start clears it."""
    agent_loop = importlib.import_module("src.agent_loop")

    async def impl(*a, **k):
        yield "data: [DONE]\n\n"
    monkeypatch.setattr(agent_loop, "_stream_agent_loop_impl", impl)
    fold_ledger.stage_pending_fold("u", "s", content="x", with_ids=["npc:3"], kind="bonding", consequence=None, felt_minutes=None, idempotency_key="k2")

    async def drive():
        return [c async for c in agent_loop.stream_agent_loop(owner="u", session_id="s")]
    _run(drive())
    assert fold_ledger.consume_staged_this_turn("u", "s") is False

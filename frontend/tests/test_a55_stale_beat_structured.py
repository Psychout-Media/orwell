"""A55 (#1814 R1a): the stale-beat reconcile runs on the engine's STRUCTURED 409 body (`code:"stale-beat"`, numeric `beatSeq`), so a wording change in the human message can no longer turn it
fail-closed. The message marker / `(now N)` regex stay only as a fallback for an older engine or a test stub. Roles only. SYNC tests (run_until_complete)."""
import asyncio
import importlib

oe = importlib.import_module("src.orwell_engine")
ch = importlib.import_module("routes.chat_helpers")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _structured(msg="Something entirely reworded: the board has moved on", seq=77):
    return oe.EngineToolError(msg, status=409, code="stale-beat", beat_seq=seq, board={"week": 1})


def test_a_reworded_message_with_the_structured_code_is_still_a_stale_beat():
    assert ch._is_stale_beat_error(_structured()) is True          # no marker anywhere in the text


def test_reconcile_adopts_the_structured_beat_seq_with_no_regex_marker(monkeypatch):
    ch._LAST_BEAT_SEQ.clear()
    ch._refresh_beat_seq("a55u", {"beatSeq": 10})

    async def _noop(*a, **k):
        return None
    monkeypatch.setattr(ch, "_capture_beat_signature", _noop)
    _run(ch._handle_stale_beat("a55u", _structured(seq=77)))
    assert ch.last_beat_seq("a55u") == 77, "the structured beatSeq must be adopted although the message has no '(now N)'"


def test_a_409_with_a_DIFFERENT_machine_code_is_not_stale_even_if_its_text_mentions_the_marker():
    e = oe.EngineToolError("turn refused: stale write refused by the integrity checkpoint (now 5)", status=409, code="turn-refused")
    assert ch._is_stale_beat_error(e) is False, "an explicit non-stale code overrides the prose"


def test_legacy_fallback_still_works_without_a_code():
    e = oe.EngineToolError("stale write refused - expected beatSeq is behind the current board (now 42); re-ground and retry", status=409)
    assert ch._is_stale_beat_error(e) is True
    ch._LAST_BEAT_SEQ.clear()

    async def _noop(*a, **k):
        return None
    import pytest
    mp = pytest.MonkeyPatch()
    try:
        mp.setattr(ch, "_capture_beat_signature", _noop)
        _run(ch._handle_stale_beat("a55legacy", e))
    finally:
        mp.undo()
    assert ch.last_beat_seq("a55legacy") == 42


def test_non_409_and_codeless_unmarked_409_are_not_stale():
    assert ch._is_stale_beat_error(oe.EngineToolError("stale-beat", status=500, code="stale-beat")) is False
    assert ch._is_stale_beat_error(oe.EngineToolError("an integrity refusal", status=409)) is False

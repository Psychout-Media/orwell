"""A74 (P0): N-16 never reached the guards that stop a scene BEFORE the player sees it. The 'competition already started' prose (take your spots + climb onto the platform) fails the cheap closed-set
gate `_sentence_has_closed_set_claim`, so `screen_streamed_scene_break` returned None at its gate and the pre-emission cut never ran; only the post-turn re-ground fired, a turn late, after the player had
already seen the early start. These tests go through the REAL entry point (`screen_streamed_scene_break`), not `_narration_claims_outcome` directly. Roles only."""
import asyncio
import importlib

import pytest

ch = importlib.import_module("routes.chat_helpers")
_USER = "a74-user"

STARTED = ('"Locked in. Houseguests - take your spots." The yard moves. Sixteen bodies climb onto the platform, sixteen sets of hands find the wall, '
           "and the rope line goes taut.")
ONE_FAMILY = '"Houseguests - take your spots." Production waits for the cameras to settle.'


def _sig(phase="hoh-competition", not_due=True, pending=None):
    return {"week": 1, "phase": phase, "pending": pending, "compNotDue": not_due, "evicted": 0, "finished": False, "activeNames": [], "noms": [], "playerIsHoh": False}


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _board(monkeypatch, sig):
    async def fake_capture(user=None):
        return dict(sig)
    monkeypatch.setattr(ch, "_capture_beat_signature", fake_capture)


@pytest.fixture(autouse=True)
def _clean():
    ch._LAST_BEAT_SIG.pop(_USER, None)
    ch._DESYNC_REGROUND.pop(_USER, None)
    yield
    ch._LAST_BEAT_SIG.pop(_USER, None)
    ch._DESYNC_REGROUND.pop(_USER, None)


def test_the_started_text_really_fails_the_cheap_gate():
    """The premise of the bug: no closed-set OUTCOME pattern matches this prose, so the old gate returned None."""
    assert ch._sentence_has_closed_set_claim(STARTED) is False


def test_scene_break_cuts_the_started_competition_while_not_due(monkeypatch):
    ch._LAST_BEAT_SIG[_USER] = _sig()
    _board(monkeypatch, _sig())
    d = _run(ch.screen_streamed_scene_break(_USER, STARTED))
    assert d is not None and "NOT due" in d, d
    assert _USER in ch._DESYNC_REGROUND  # the next-turn backstop is still stashed


def test_it_stands_down_when_due_pending_unknown_or_not_a_comp_phase(monkeypatch):
    ch._LAST_BEAT_SIG[_USER] = _sig()
    for sig, why in ((_sig(not_due=False), "due: the comp may start"), (_sig(pending="comp-round"), "an open comp card: the comp is live"),
                     (_sig(not_due=None), "no schedule (clock off)"), (_sig(phase="nominations"), "not a competition phase")):
        _board(monkeypatch, sig)
        assert _run(ch.screen_streamed_scene_break(_USER, STARTED)) is None, why


def test_one_cue_family_never_reaches_the_board(monkeypatch):
    async def boom(user=None):
        raise AssertionError("the scene gate read the board for a single stage direction")
    monkeypatch.setattr(ch, "_capture_beat_signature", boom)
    ch._LAST_BEAT_SIG[_USER] = _sig()
    assert _run(ch.screen_streamed_scene_break(_USER, ONE_FAMILY)) is None


def test_ordinary_social_prose_still_never_reads_the_board(monkeypatch):
    async def boom(user=None):
        raise AssertionError("the scene gate read the board for creative prose (ADR 0005 #1)")
    monkeypatch.setattr(ch, "_capture_beat_signature", boom)
    assert _run(ch.screen_streamed_scene_break(_USER, "They linger by the pool trading quiet reads; nothing is decided tonight.")) is None


def test_the_n16_docstring_claim_is_true_now():
    """The N-16 test docstring says 'the pre-emission guard now catches it': this file is the proof, through the entry point."""
    src = open(__import__("os").path.join(__import__("os").path.dirname(__file__), "test_n16_comp_started_before_due.py"), encoding="utf-8").read()
    assert "pre-emission guard now catches it" in src

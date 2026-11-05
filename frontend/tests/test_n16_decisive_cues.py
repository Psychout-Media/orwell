"""N-16 decisive cues, found in the LIVE week-1 run (2026-11-05): while production HELD the HOH competition ("not due yet", daySchedule.due False, nothing pending) the narrator said the competition "is live and waiting on you", then
described the wall and wrote "The competition resolves. <Name> wins it." with no engine event - a phantom outcome. The >= 2 cue-family rule let it through because each sentence carries ONE family and no closed-set
outcome pattern. A statement that the competition IS LIVE or has RESOLVED/been WON is conclusive on its own, so it counts alone. Through the real entry point. Roles only."""
import asyncio
import importlib

import pytest

ch = importlib.import_module("routes.chat_helpers")
_USER = "n16-decisive"

LIVE_ANNOUNCE = ("((Everyone's already outside for the first Head of Household competition - the house is standing in the backyard waiting on you, and the competition is live. "
                 "Tell me how you're approaching it - all out, playing it safe, or holding back - and it runs.))")
RESOLVED = "The competition resolves.\n\nEllis wins it. They come down off the wall with chalk on their hands and their hair coming loose."
NEGATED = "The competition isn't live yet - production hasn't called it, so the house drifts back toward the kitchen."
FUTURE = "When the competition is live, everyone will be out in the yard; until then the house is quiet."
SOCIAL = "They linger by the pool trading quiet reads; nothing is decided tonight."


def _sig(not_due=True, pending=None, phase="hoh-competition"):
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


@pytest.mark.parametrize("text", [LIVE_ANNOUNCE, RESOLVED])
def test_a_live_or_resolved_competition_is_cut_while_production_holds_it(monkeypatch, text):
    ch._LAST_BEAT_SIG[_USER] = _sig()
    _board(monkeypatch, _sig())
    d = _run(ch.screen_streamed_scene_break(_USER, text))
    assert d is not None and "NOT due" in d, d


@pytest.mark.parametrize("text", [LIVE_ANNOUNCE, RESOLVED])
def test_it_stands_down_when_the_competition_is_due_or_open(monkeypatch, text):
    ch._LAST_BEAT_SIG[_USER] = _sig()
    for sig in (_sig(not_due=False), _sig(pending="comp-round"), _sig(not_due=None), _sig(phase="premiere", not_due=None)):  # a non-competition BOARD phase is N-16b, tested below
        _board(monkeypatch, sig)
        assert _run(ch.screen_streamed_scene_break(_USER, text)) is None


@pytest.mark.parametrize("text", [NEGATED, FUTURE, SOCIAL])
def test_a_denial_a_future_mention_or_social_prose_is_never_cut(monkeypatch, text):
    ch._LAST_BEAT_SIG[_USER] = _sig()
    _board(monkeypatch, _sig())
    assert _run(ch.screen_streamed_scene_break(_USER, text)) is None


# ── N-16b: a finished competition REPLAYED in a non-competition phase (live week 1: with Olive already the HOH the narrator announced "The Head of Household competition begins now" and kept the house on the wall) ──
REPLAY_ANNOUNCE = 'Then the speakers crackle.\n\n**"Houseguests. The Head of Household competition begins now. Everyone to the backyard."**\n\nThe kitchen erupts.'
REPLAY_ASIDE = ("((The house is mid-competition - everyone's on the wall in the backyard, so there's no room to step into. The live moment is the ledge under your hands: the wall's tilting, "
                "and production needs to know how you're playing it.))")
PAST_RECAP = "Yesterday's Head of Household competition was won by Olive, who came down off the wall with chalk on her hands. Nominations are this afternoon."


@pytest.mark.parametrize("text", [REPLAY_ANNOUNCE, REPLAY_ASIDE])
@pytest.mark.parametrize("phase", ["nominations", "veto-ceremony", "eviction"])
def test_a_competition_announced_live_in_a_non_competition_phase_is_cut(monkeypatch, text, phase):
    ch._LAST_BEAT_SIG[_USER] = _sig(phase=phase, not_due=None)
    _board(monkeypatch, _sig(phase=phase, not_due=None))
    d = _run(ch.screen_streamed_scene_break(_USER, text))
    assert d is not None and "no competition is running" in d, d


def test_a_past_tense_recap_of_the_finished_competition_is_never_cut(monkeypatch):
    ch._LAST_BEAT_SIG[_USER] = _sig(phase="nominations", not_due=None)
    _board(monkeypatch, _sig(phase="nominations", not_due=None))
    assert _run(ch.screen_streamed_scene_break(_USER, PAST_RECAP)) is None


def test_the_replay_cut_stands_down_in_a_competition_phase_with_a_card_open_or_in_the_premiere(monkeypatch):
    ch._LAST_BEAT_SIG[_USER] = _sig()
    for sig in (_sig(phase="premiere", not_due=None), _sig(phase="nominations", not_due=None, pending="nominations")):
        _board(monkeypatch, sig)
        assert _run(ch.screen_streamed_scene_break(_USER, REPLAY_ANNOUNCE)) is None

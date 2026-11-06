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
    for sig in (_sig(not_due=False), _sig(pending="comp-round"), _sig(not_due=None)):  # a non-competition BOARD phase (premiere, nominations...) is N-16b, tested below
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
PREMIERE_ABOUT = ("The sixteen of you shuffle into place on the grass as the speakers crackle: Houseguests - the competition is about to begin. Nobody goes back inside until we have a Head of Household. "
                  "The first piece of the competition gets wheeled out.")
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
    for sig in (_sig(phase="nominations", not_due=None, pending="nominations"), _sig(phase="hoh-competition", not_due=False)):
        _board(monkeypatch, sig)
        assert _run(ch.screen_streamed_scene_break(_USER, REPLAY_ANNOUNCE)) is None


def test_a_competition_announced_as_about_to_begin_during_the_premiere_is_cut(monkeypatch):
    """Live week 1 (replay 3): at 11am on premiere morning the narrator trapped the player on the lawn ('Nobody goes back inside until we have a Head of Household') while the engine had the competition due in the afternoon."""
    ch._LAST_BEAT_SIG[_USER] = _sig(phase="premiere", not_due=None)
    _board(monkeypatch, _sig(phase="premiere", not_due=None))
    d = _run(ch.screen_streamed_scene_break(_USER, PREMIERE_ABOUT))
    assert d is not None and "no competition is running" in d, d


# ── a phantom EVICTION fast-forwarded on the nominations morning (live replay 4), through the real entry point ──
PHANTOM_EVICTION = ("The vote's read, the house has said its piece, and the evictee comes down the stairs with their bag already packed by production and that hollow look people get when the floor's just dropped out.")


def test_a_fast_forwarded_eviction_in_the_nominations_phase_is_held(monkeypatch):
    sig = {"week": 1, "phase": "nominations", "pending": None, "hoh": "npc:1", "noms": [], "vetoHolder": None, "vetoUsed": False, "evicted": 0, "finished": False}
    ch._LAST_BEAT_SIG[_USER] = dict(sig)

    async def fake_capture(user=None):
        return dict(sig)
    monkeypatch.setattr(ch, "_capture_beat_signature", fake_capture)
    assert _run(ch.screen_streamed_outcome(_USER, PHANTOM_EVICTION)) is False
    assert _USER in ch._DESYNC_REGROUND


def test_a_hypothetical_or_recap_about_the_vote_is_not_held(monkeypatch):
    sig = {"week": 1, "phase": "nominations", "pending": None, "hoh": "npc:1", "noms": [], "vetoHolder": None, "vetoUsed": False, "evicted": 0, "finished": False}
    ch._LAST_BEAT_SIG[_USER] = dict(sig)

    async def fake_capture(user=None):
        return dict(sig)
    monkeypatch.setattr(ch, "_capture_beat_signature", fake_capture)
    assert ch._sentence_has_closed_set_claim("They talk about how nominations work and who might end up going to the block.") is False


# ── a committed ceremony beat the narration never voiced (live replay 4: the nominations were pre-resolved in framing and the narrator answered an unrelated question) ──
def test_an_unvoiced_nominations_ceremony_is_regrounded_into_the_next_turn(monkeypatch):
    sig = {"week": 1, "phase": "veto-competition", "pending": None, "hoh": "npc:1", "noms": ["npc:5", "npc:6"], "vetoHolder": None, "vetoUsed": False, "evicted": 0, "finished": False}
    ch._LAST_BEAT_SIG[_USER] = dict(sig)

    async def fake_capture(user=None):
        return dict(sig)
    monkeypatch.setattr(ch, "_capture_beat_signature", fake_capture)
    ch.note_ceremony_beat_for_voicing(_USER, "Isaac Okoro nominates Tristan Ballard and Denise Calloway", ["Tristan Ballard", "Denise Calloway"])
    _run(ch.record_post_turn_desync_check(_USER, "Erin doesn't hesitate. 'Play it,' she says. 'Straight. No games.'"))
    assert _USER in ch._DESYNC_REGROUND and "RE-GROUND ON THE CEREMONY" in ch._DESYNC_REGROUND[_USER]
    assert "Tristan Ballard" in ch._DESYNC_REGROUND[_USER]


def test_a_voiced_ceremony_queues_nothing(monkeypatch):
    sig = {"week": 1, "phase": "veto-competition", "pending": None, "hoh": "npc:1", "noms": ["npc:5", "npc:6"], "vetoHolder": None, "vetoUsed": False, "evicted": 0, "finished": False}
    ch._LAST_BEAT_SIG[_USER] = dict(sig)

    async def fake_capture(user=None):
        return dict(sig)
    monkeypatch.setattr(ch, "_capture_beat_signature", fake_capture)
    ch.note_ceremony_beat_for_voicing(_USER, "Isaac Okoro nominates Tristan Ballard and Denise Calloway", ["Tristan Ballard", "Denise Calloway"])
    _run(ch.record_post_turn_desync_check(_USER, "The room goes still as Isaac reads two names: Tristan, and then Denise."))
    assert _USER not in ch._DESYNC_REGROUND


# ── a phantom veto holder (live replay 4: "He turns the veto over" with no veto played) ──
VETO_PHANTOM = "They laugh, a little giddy.\n\nMV: What am I gonna do? I have no idea.\n\nHe turns the veto over. \"I'm not using it to make a point,\" he says."
VETO_HYP = "Nobody has played for the veto yet, and every conversation in the house circles it; the draw is this afternoon."


def test_a_houseguest_holding_the_veto_when_none_was_played_is_cut(monkeypatch):
    sig = _sig(phase="veto-competition", not_due=True)
    sig.update({"vetoHolder": None, "vetoUsed": False})
    ch._LAST_BEAT_SIG[_USER] = dict(sig)
    _board(monkeypatch, sig)
    d = _run(ch.screen_streamed_scene_break(_USER, VETO_PHANTOM))
    assert d is not None and "Power of Veto" in d, d


def test_a_hypothetical_about_the_veto_is_not_cut(monkeypatch):
    sig = _sig(phase="veto-competition", not_due=True)
    sig.update({"vetoHolder": None, "vetoUsed": False})
    ch._LAST_BEAT_SIG[_USER] = dict(sig)
    _board(monkeypatch, sig)
    assert _run(ch.screen_streamed_scene_break(_USER, VETO_HYP)) is None


def test_the_veto_possession_cut_stands_down_when_the_engine_has_a_holder(monkeypatch):
    sig = _sig(phase="veto-ceremony", not_due=False)
    sig.update({"vetoHolder": "npc:3", "vetoHolderName": "Someone Real", "vetoUsed": False})
    ch._LAST_BEAT_SIG[_USER] = dict(sig)
    _board(monkeypatch, sig)
    assert _run(ch.screen_streamed_scene_break(_USER, VETO_PHANTOM)) is None


# ── a stale/wrong clock statement (live replay 4: "It's 8:10am on day 4" at ~11am, long after the nominations) ──
def _sig_clock(label, phase="veto-competition"):
    s = _sig(phase=phase, not_due=True)
    s["clockLabel"] = label
    return s


def test_a_wrong_current_time_is_cut(monkeypatch):
    sig = _sig_clock("11:35am, Day 4")
    ch._LAST_BEAT_SIG[_USER] = dict(sig)
    _board(monkeypatch, sig)
    d = _run(ch.screen_streamed_scene_break(_USER, "It's 8:10am on day 4. Today's beat is the nomination ceremony - Isaac names two people, this afternoon."))
    assert d is not None and "11:35am, Day 4" in d, d


def test_a_wrong_day_is_cut_even_with_the_right_time(monkeypatch):
    sig = _sig_clock("11:35am, Day 4")
    ch._LAST_BEAT_SIG[_USER] = dict(sig)
    _board(monkeypatch, sig)
    assert _run(ch.screen_streamed_scene_break(_USER, "It's 11:30am on day 3 and the house is quiet.")) is not None


def test_a_correct_time_a_future_event_time_or_no_clock_is_never_cut(monkeypatch):
    sig = _sig_clock("11:35am, Day 4")
    ch._LAST_BEAT_SIG[_USER] = dict(sig)
    _board(monkeypatch, sig)
    for ok in ("It's about 11:30am, and the veto draw is at 1:00pm.", "The veto draw is at 1:00pm, they say; nobody believes it.", "It's 11:40am on day 4."):
        assert _run(ch.screen_streamed_scene_break(_USER, ok)) is None, ok
    nosig = _sig()
    ch._LAST_BEAT_SIG[_USER] = dict(nosig)
    _board(monkeypatch, nosig)
    assert _run(ch.screen_streamed_scene_break(_USER, "It's 8:10am on day 4.")) is None


def test_an_unvoiced_veto_result_is_regrounded_with_the_winner(monkeypatch):
    sig = {"week": 1, "phase": "veto-ceremony", "pending": None, "hoh": "npc:1", "noms": ["npc:5", "npc:6"], "vetoHolder": "npc:4", "vetoUsed": False, "evicted": 0, "finished": False}
    ch._LAST_BEAT_SIG[_USER] = dict(sig)

    async def fake_capture(user=None):
        return dict(sig)
    monkeypatch.setattr(ch, "_capture_beat_signature", fake_capture)
    ch.note_ceremony_beat_for_voicing(_USER, "Nia Coleman wins the Power of Veto", ["Nia Coleman"])
    _run(ch.record_post_turn_desync_check(_USER, "Tessa grins. 'Who would I put up? Filthy question.'"))
    assert _USER in ch._DESYNC_REGROUND and "Nia Coleman" in ch._DESYNC_REGROUND[_USER]

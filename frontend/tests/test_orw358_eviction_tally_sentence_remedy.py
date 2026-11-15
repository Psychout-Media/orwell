"""ORW-358: on eviction night the narrator invented the vote tally ("Nine to four") over the engine's real count (11 to 2) and the scene circuit-breaker
cut the WHOLE beat, losing the goodbyes and reactions. The engine now hands the count over as a fact (tests/unit/hardConstraintsBoard.test.ts); when the
narrator still states a wrong number on a night whose evictee is committed, ONLY that sentence is dropped. A wrong evictee, a phantom result, or a
correct tally are unchanged. Roles only."""
import asyncio
import importlib

import pytest

ch = importlib.import_module("routes.chat_helpers")
agent_loop = importlib.import_module("src.agent_loop")

_USER = "u-orw358"


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _sig(**over):
    base = {"week": 1, "phase": "eviction", "pending": None, "hoh": "npc:9", "hohName": "Hoh Person", "noms": ["npc:1", "npc:2"],
            "nomNames": ["Nom Alpha", "Nom Beta"], "activeNames": ["Nom Alpha", "Nom Beta", "Hoh Person", "Other One"],
            "evicted": 0, "evictedNames": [], "finished": False, "ballotCounts": None, "evictionEvictee": None,
            "playerIsHoh": False, "playerHasVeto": False}
    base.update(over)
    return base


BEFORE = _sig()
AFTER = _sig(evicted=1, evictedNames=["Nom Alpha"], ballotCounts=[11, 2], evictionEvictee="Nom Alpha")

SCENE = ('**"Nom Alpha, you are evicted from the Big Brother house."**\n\nNine to four. Nom Alpha\'s chin comes up a fraction.\n\n'
         'Nom Alpha says goodbye to Other One with a warm hug and a quiet word.\n\nHoh Person watches the door close.')


@pytest.fixture(autouse=True)
def _state(monkeypatch):
    for d in (ch._LAST_BEAT_SIG, ch._DESYNC_REGROUND, ch._SCENE_REWRITE):
        d.pop(_USER, None)
    ch._LAST_BEAT_SIG[_USER] = dict(BEFORE)

    async def cap(user=None):
        return dict(cap.sig)
    cap.sig = AFTER
    monkeypatch.setattr(ch, "_capture_beat_signature", cap)
    yield cap
    for d in (ch._LAST_BEAT_SIG, ch._DESYNC_REGROUND, ch._SCENE_REWRITE):
        d.pop(_USER, None)


def test_wrong_tally_on_a_committed_night_keeps_the_goodbyes():
    assert ch._narration_claims_outcome(SCENE, BEFORE, AFTER)  # the old whole-scene cut trigger
    assert _run(ch.screen_streamed_scene_break(_USER, SCENE)) is None  # not cut
    kept = ch.take_scene_rewrite(_USER)
    assert kept and "Nine to four" not in kept
    assert "warm hug" in kept and "watches the door close" in kept and "you are evicted" in kept
    assert not ch._DESYNC_REGROUND.get(_USER)  # nothing to re-ground: the scene was fine bar one sentence


def test_emit_helper_streams_the_kept_scene_not_a_cutaway():
    out = _run(agent_loop._emit_guarded_scene(SCENE, _USER, scene_broken=False, emitted_visible=False, cutaway_emitted=False))
    assert out.scene_broken is False
    assert "warm hug" in out.text and "Nine to four" not in out.text
    assert out.text != agent_loop._SCENE_CUTAWAY_LINE


def test_a_correct_tally_is_untouched(_state):
    text = SCENE.replace("Nine to four", "Eleven to two")
    assert _run(ch.screen_streamed_scene_break(_USER, text)) is None
    assert ch.take_scene_rewrite(_USER) is None  # no rewrite: the text streams as-is


def test_a_wrong_evictee_is_still_cut_whole():
    text = "Other One is evicted from the house tonight. Eleven to two. Hoh Person watches the door close."
    d = _run(ch.screen_streamed_scene_break(_USER, text))
    assert d and "WRONG evictee" in d
    assert ch.take_scene_rewrite(_USER) is None


def test_a_wrong_tally_plus_a_wrong_evictee_is_still_cut_whole():
    text = "Other One is evicted from the house tonight. Nine to four. Hoh Person watches the door close."  # wrong evictee AND a wrong tally
    assert _run(ch.screen_streamed_scene_break(_USER, text))
    assert ch.take_scene_rewrite(_USER) is None


def test_an_uncommitted_evictee_keeps_the_whole_scene_cut(_state):
    _state.sig = _sig(evicted=0, ballotCounts=[11, 2], evictionEvictee=None)
    d = _run(ch.screen_streamed_scene_break(_USER, "Nine to four. The room goes quiet."))
    assert d and "TALLY" in d
    assert ch.take_scene_rewrite(_USER) is None


def test_drop_helper_is_sentence_level_and_pure():
    out = ch.drop_wrong_tally_sentences("One. Nine to four. Two.", AFTER)
    assert "Nine" not in out and "One." in out and "Two." in out
    assert ch.drop_wrong_tally_sentences("Eleven to two.", AFTER) == "Eleven to two."
    assert ch.drop_wrong_tally_sentences("Nine to four.", _sig(ballotCounts=[11, 2])) == "Nine to four."  # no committed evictee: unchanged

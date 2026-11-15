"""ORW-374: the ceremony-claim verifier must not read (1) a host's RULES SPEECH as a crowning, nor (2) a vocative naming the engine's REAL HOH as a claim
that the PLAYER was crowned. Fixtures are the two real narrator sentences from the 2026-11-15 rehearsal (ORW-373); real early claims stay flagged. Roles only."""
import importlib

import pytest

ch = importlib.import_module("routes.chat_helpers")

RULES = ('"Houseguests - welcome to your first Head of Household competition. There is no sitting this one out and there is no second chance. '
         'Last person standing on the platform is the new Head of Household."')
VOCATIVE = '"**Hoh Person — you are the new Head of Household.**"'


def _sig(**over):
    base = {"week": 1, "phase": "nominations", "pending": None, "hoh": "npc:1", "hohName": "Hoh Person", "noms": [], "nomNames": [],
            "activeNames": ["Hoh Person", "Other Person", "Third Person"], "evicted": 0, "evictedNames": [], "finished": False, "ballotCounts": None,
            "evictionEvictee": None, "playerIsHoh": False, "playerHasVeto": False, "vetoHolder": None, "vetoHolderName": None}
    base.update(over)
    return base


HOH_COMP = _sig(phase="hoh-competition", pending="comp-round", hoh=None, hohName=None)


@pytest.mark.parametrize("text", [
    RULES,
    "Last person standing on the platform is the new Head of Household.",
    "The winner will be the new Head of Household.",
    "Whoever outlasts the rest becomes the new Head of Household.",
    "The one who holds on longest will be the new HOH.",
    "If you hold on, you'll be the new Head of Household.",
    "First one to the buzzer is the new HOH.",
    "Remember the rules: last one standing wins the HOH.",
])
def test_rules_and_conditional_speech_is_not_a_result_claim(text):
    assert ch._narration_claims_outcome(text, HOH_COMP, HOH_COMP) is None


def test_the_real_vocative_to_the_engines_hoh_is_not_a_self_crown():
    sig = _sig()
    assert ch._narration_claims_outcome(VOCATIVE, sig, sig) is None
    assert ch._narration_claims_outcome('@[Hoh Person], you are the new Head of Household.', sig, sig) is None
    assert ch._narration_claims_outcome('"Hoh, you are the new Head of Household."', sig, sig) is None  # first-name token of the real HOH


@pytest.mark.parametrize("text, sig, label", [
    ("Hoh Person is crowned the new HOH.", HOH_COMP, "HEAD OF HOUSEHOLD"),                       # a genuine early crowning
    ("The host announces it: Other Person is the new Head of Household.", HOH_COMP, "HEAD OF HOUSEHOLD"),
    ("Hoh Person, last one standing, is the new Head of Household.", HOH_COMP, "HEAD OF HOUSEHOLD"),  # result phrase, not a rule
    ("Other Person wins HOH.", HOH_COMP, "HEAD OF HOUSEHOLD"),
    ("You are the new Head of Household.", _sig(), "HEAD OF HOUSEHOLD"),                          # self-crown, player not HOH
    ("You won HOH! Everyone erupts.", _sig(), "HEAD OF HOUSEHOLD"),
    ('"Other Person — you are the new Head of Household."', _sig(), "HEAD OF HOUSEHOLD"),     # vocative naming a DIFFERENT person than the engine's HOH
    ('"You are the new Head of Household."', _sig(hoh=None, hohName=None), "HEAD OF HOUSEHOLD"),   # no real HOH to name
])
def test_real_early_claims_and_wrong_identities_are_still_flagged(text, sig, label):
    d = ch._narration_claims_outcome(text, sig, sig)
    assert d and label in d


def test_vocative_helper_needs_the_real_hoh_name():
    def at(t, sig):
        return ch._vocative_to_real_hoh(t, t.index("you are"), sig)
    assert at('"Hoh Person \u2014 you are', _sig())
    assert not at('"Other Person \u2014 you are', _sig())
    assert not at('"Hoh Person \u2014 you are', _sig(hohName=None))
    assert not at('They say Hoh Person, you are', _sig())  # prose before the name is not a bare vocative


def test_article_form_is_a_rule_only_inside_a_quoted_speech():
    recap = "The last houseguest standing is the first Head of Household of the season."
    assert ch._narration_claims_outcome(recap, HOH_COMP, HOH_COMP)  # the narrator's own recap voice stays a claim (test_orw273)
    quoted = 'The host reads the rules. "No second chances. The last houseguest standing is the new Head of Household."'
    assert ch._narration_claims_outcome(quoted, HOH_COMP, HOH_COMP) is None


@pytest.mark.parametrize("text, sig", [(RULES, HOH_COMP)])
def test_the_real_rules_speech_passes_through_the_stream_guard_untouched(text, sig):
    """ORW-437 (review of #2658): the stream-level check that the ORW-373 file's fixture swap dropped. It found that the pre-emission HARD-DROP rail
    (`_sentence_has_chyron_covered_claim`) still dropped the rules speech: fixed. (The vocative fixture is still hard-dropped there by design, the chyron carries the crown.) The
    real `screen_streamed_scene_break` / `_emit_guarded_scene` path and stay byte-identical: no rewrite, no cut."""
    import asyncio
    agent_loop = importlib.import_module("src.agent_loop")
    user = "u-orw374-stream"

    async def cap(user=None):
        return dict(sig)

    orig = ch._capture_beat_signature
    ch._capture_beat_signature = cap
    try:
        ch._LAST_BEAT_SIG[user] = dict(sig)
        loop = asyncio.new_event_loop()
        assert loop.run_until_complete(ch.screen_streamed_scene_break(user, text)) is None
        assert ch.take_scene_rewrite(user) is None
        g = loop.run_until_complete(agent_loop._emit_guarded_scene(text, user, scene_broken=False, emitted_visible=False, cutaway_emitted=False))
        loop.close()
    finally:
        ch._capture_beat_signature = orig
        ch._LAST_BEAT_SIG.pop(user, None)
        ch._DESYNC_REGROUND.pop(user, None)
    assert g.scene_broken is False and g.text == text

"""Runway readiness: a player who just wants the game to move must not need magic words (rehearsal E-1 2026-11-04). A SHORT message that is only a
progression word ("advance", "continue", "ok next", "go on", "proceed", "keep going", "move forward") ends the social runway and drives the next ceremony;
substantive scheming that merely CONTAINS those words never does (the J-3 contract: the cue is unambiguous). Roles only."""
import pytest

from routes import chat_helpers as ch


@pytest.mark.parametrize("msg", [
    "advance", "Advance.", "continue", "ok continue", "okay, next", "next", "go on", "proceed", "keep going", "move forward",
    "advance to the nominations", "continue to the veto", "advance — veto ceremony, then on to eviction night",
    "Please call advanceGame", "ok go ahead", "nothing, just continue", "skip", "go ahead",
])
def test_a_short_progression_message_is_readiness(msg):
    assert ch._player_signals_ready(msg) is True, msg


@pytest.mark.parametrize("msg", [
    "I want to nominate Role B next week, talk her into it",
    "I tell Role A to advance the plan before the veto and not to continue lying to me",
    "Role C, keep going with your story about last night, I want every detail",
    "I whisper to Role D that we should go on a walk and talk about the vote tonight",
    "we should skip Role E's alliance and make our own",
    "next time Role F talks I'm leaving the room",
    "", "   ", "hi", "who holds the veto?",
])
def test_scheming_or_chat_that_merely_contains_the_words_is_not_readiness(msg):
    assert ch._player_signals_ready(msg) is False, msg


def test_the_original_explicit_cues_still_work():
    for m in ["let's move on", "what's next", "i'm ready", "get on with it", "let's see the noms"]:
        assert ch._player_signals_ready(m) is True, m

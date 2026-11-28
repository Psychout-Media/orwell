"""ORW-1150 (prod 11-28, Ryne): three sleep requests were refused by the bed-intent check, so turnIn was never
offered, act-first skipped as ungrounded, and the narrator jumped to morning in prose while the engine stayed at
night. A polite request ("I would like to...") and a bare command ("Sleep.") are the player's own act."""
import pytest

# The three prod messages that were refused (paraphrase-free shapes: these are the request forms, not chat text).
PROD_SHAPES = [
    "I would like to go to bed.",
    "Sleep.",
    "I would like to go to sleep now... please... im tired. ...",
]
MORE_YES = ["I'd like to go to bed", "Go to sleep.", "Bed.", "Goodnight", "I want to go to sleep now",
            "let me sleep", "okay, sleep now please", "I'm gonna sleep", "Time for bed."]
STILL_NO = ["I would go to bed if Jace left.", "Do you want to sleep?", "She would like to go to bed.",
            "I don't want to go to sleep yet.", "Is Scott sleeping in this room?", "Maybe I'll go to bed later.",
            "I would like to talk to Jace before bed.", "sleep tight, Valerie", "I want to know where Scott sleeps.",
            "Bedtime story?", "I would like to know whose bed this is."]


@pytest.mark.parametrize("text", PROD_SHAPES + MORE_YES)
def test_sleep_request_counts(text):
    from src.agent_loop import _player_means_going_to_bed
    assert _player_means_going_to_bed(text) is True, text


@pytest.mark.parametrize("text", STILL_NO)
def test_non_requests_still_refused(text):
    from src.agent_loop import _player_means_going_to_bed
    assert _player_means_going_to_bed(text) is False, text

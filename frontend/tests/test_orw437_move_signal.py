"""ORW-437 (review of #2705): the auto-move pre-filter sees the dining room, the hallway and entry verbs."""
import pytest

from src.agent_loop import _MOVE_SIGNAL_RE


@pytest.mark.parametrize("text", ["You enter the dining room.", "She arrives in the hallway.", "Sam is in the dining-room now.", "They walk into the hall."])
def test_new_rooms_and_entry_verbs_pass_the_prefilter(text):
    assert _MOVE_SIGNAL_RE.search(text)


def test_plain_prose_still_misses():
    assert not _MOVE_SIGNAL_RE.search("The sun is bright and the coffee is cold.")

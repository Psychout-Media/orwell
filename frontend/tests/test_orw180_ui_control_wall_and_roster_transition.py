"""ORW-180 - (1) `ui_control` must never reach the game narrator (it survived the game-build wall when the keyword
fallback matched "message"/"resend", live 11-06); (2) the invented-houseguest roster check must not read a
sentence-initial transition word before a REAL roster name ("Meanwhile Marcus ...") as an unknown full name."""
import importlib

import pytest

from src.agent_tools import GAME_NARRATOR_TOOL_DROP, GAME_TOOL_KEEP

ch = importlib.import_module("routes.chat_helpers")
_FULL = {"marcus webb", "ana flores", "devon reyes"}
_FIRST = {"marcus", "ana", "devon"}


def test_ui_control_is_dropped_from_the_game_narrator_but_kept_for_admin_turns():
    assert "ui_control" in GAME_NARRATOR_TOOL_DROP
    assert "ui_control" in GAME_TOOL_KEEP  # subset-of-KEEP invariant: still available on non-game turns


@pytest.mark.parametrize("line", [
    "Meanwhile Marcus says, \"we need to talk.\"",
    "Later Ana walks into the kitchen and laughs.",
    "Suddenly Devon steps forward and says nothing.",
    "Meanwhile Marcus Webb walks to the couch.",
])
def test_transition_word_before_a_real_roster_name_is_not_invented(line):
    assert ch._sentence_names_invented(line, _FIRST, _FULL) is None, line


def test_a_genuinely_invented_name_after_a_transition_word_is_still_flagged():
    assert ch._sentence_names_invented("Suddenly Harrison Cole leans in and grins.", _FIRST, _FULL) == "Harrison Cole"


def test_plain_invented_name_still_flagged():
    assert ch._sentence_names_invented("Harrison Cole leans against the counter and grins.", _FIRST, _FULL) == "Harrison Cole"

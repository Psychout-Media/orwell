"""ORW-738 (Season 2 week 3 playtest, build before #3105): on eviction night the narrator voiced Production's evictee line before the engine had committed the
result, the role-claim guard stripped it (correctly: a phantom result), and the player's bubble was left with a lone opening quote and an empty paragraph
(`"` then a blank line) where the announcement belonged, with the next line's bold wrapper orphaned. #3105 made a stripped unit take its quote marks with it.
This pins the transcript's shape end to end through the real `screen_role_units` so the blank line cannot come back, for the plain and the bold-wrapped forms,
with the engine's result NOT yet committed and ALSO once it is committed (then the line must pass whole). Roles only; synthetic names."""
import importlib

import pytest

rc = importlib.import_module("src.role_claims")

ROSTER = ["Hoh Person", "Nom Alpha", "Other Delta"]
PRE = "Then the voice comes down over the room, warm and brisk and completely without ceremony.\n\n"
POST = "\n\nThe room breaks apart the way it always does.\n\n**\"Houseguests, the goodbye messages.\"**\n"


def sig(**kw):
    base = {"phase": "eviction", "activeNames": list(ROSTER), "evictedNames": [], "playerName": "Player Epsilon", "hohName": "Hoh Person",
            "vetoHolderName": "Hoh Person", "nomNames": ["Nom Alpha", "Player Epsilon"], "playerStatus": "active", "evictionBallots": 11, "pending": None}
    base.update(kw)
    return base


LINES = [
    '"By a vote of 11 to 0, Player Epsilon, you have been evicted from the Big Brother house."',
    '"By a vote of 11 to 0, you have been evicted from the Big Brother house, Player Epsilon."',
    '"The houseguest who has been evicted by a vote of 11 to 0 is... Player Epsilon."',
]


@pytest.mark.parametrize("line", LINES)
def test_an_uncommitted_result_line_is_dropped_whole_with_no_orphan_quote_or_blank_paragraph(line):
    kept, out, _ = rc.screen_role_units(PRE + line + POST, sig(), None)
    assert out, "the premature evictee line must be stripped"
    assert "evicted" not in kept.split("The room breaks apart")[0]
    head = kept.split("The room breaks apart")[0]
    assert head.count('"') % 2 == 0 and "**" not in head          # no lone quote / bold wrapper left behind
    assert head.rstrip().endswith("ceremony.")                      # nothing but whitespace where the line was
    assert '**"Houseguests, the goodbye messages."**' in kept     # the next line is untouched


@pytest.mark.parametrize("line", LINES[:2])
def test_the_same_line_passes_whole_once_the_engine_committed_the_player_as_the_evictee(line):
    text = PRE + line + POST
    kept, out, _ = rc.screen_role_units(text, sig(evictionEvictee="Player Epsilon"), None)
    assert kept == text and not out

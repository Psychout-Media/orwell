"""PO ruling 2026-11-04 (Ryne): the eviction vote reveal is ALL IN ONE TURN. The engine hands the narrator EVERY anonymized ballot, so a numeric tally that AGREES
with them is truth (the old BE-202 rule treated ANY tally as a fabrication and cut ~14 eviction-night scenes in the 2026-11-04 autopilot). A tally that contradicts
the ballots, or one narrated before any ballot was read, is still a fabrication. Roles only."""
import importlib

import pytest

ch = importlib.import_module("routes.chat_helpers")


def _sig(**kw):
    base = {"phase": "eviction", "evicted": 1, "evictedNames": [], "ballotCounts": None, "week": 1, "pending": None, "finished": False,
            "nomNames": ["Nom Alpha", "Nom Beta"], "activeNames": ["Nom Alpha", "Nom Beta"], "hohName": "Hoh Person"}
    base.update(kw)
    return base


def _claims(text, after, before=None):
    return ch._narration_claims_outcome(text, before or _sig(), after)


def test_ballot_counts_come_from_the_revealed_ballots():
    ev = {"votesRevealed": [{"votedFor": {"id": "a"}}] * 3 + [{"votedFor": {"id": "b"}}] * 9}
    assert ch._ballot_counts(ev) == [9, 3]
    assert ch._ballot_counts({"votesRevealed": []}) is None and ch._ballot_counts(None) is None


@pytest.mark.parametrize("text", ["By a vote of nine to three, the house has spoken.", "It is 9-3.", "Nine votes to evict Nom Alpha. Three votes to evict Nom Beta.",
                                  "Nine to three."])
def test_a_tally_that_matches_the_revealed_ballots_is_not_a_fabrication(text):
    assert not _claims(text, _sig(ballotCounts=[9, 3]))


@pytest.mark.parametrize("text", ["By a vote of eight to four, the house has spoken.", "Ten votes to evict Nom Alpha."])
def test_a_tally_that_contradicts_the_ballots_is_still_flagged(text):
    assert _claims(text, _sig(ballotCounts=[9, 3]))


def test_a_tally_before_any_ballot_was_read_is_still_flagged():
    assert _claims("By a vote of nine to three, the house has spoken.", _sig(ballotCounts=None))


def test_a_unanimous_night_and_a_non_nominee_ballot():
    assert not _claims("Twelve votes to evict Nom Alpha.", _sig(ballotCounts=[12]))
    assert _claims("Eleven votes to evict Nom Alpha.", _sig(ballotCounts=[12]))
    assert _claims("Nine votes to evict Some Outsider.", _sig(ballotCounts=[9, 3])), "a count for someone who is not a nominee is never sanctioned"

"""ORW-25 (A80 follow-up) — the N-3 stale-denial guard must not read a hypothetical or a negated report as a denial.

N-3 (`_stale_denial_contradiction`) catches a STALE "not yet": the engine has committed the nominees (or crowned
the HOH, or set the veto holder) and the narration still says it has not happened. It stands down on a
hypothetical clause, but its hypothetical cue list (`_VETO_N1_HYP_RE`) had no "imagine", "suppose", "assuming",
"in case", "hypothetically" or "pretend", and no negated report ("nobody says ..."). A80 noticed two lines it
flags: "Imagine the nominees aren't set yet." and "Nobody says the nominees haven't been named." Neither asserts
the nominees are unset. Because N-3 feeds `_narration_claims_outcome`, a flag there cut the WHOLE scene.

Both-way tests: the hypothetical and the negated report stand; a real stale denial with the nominees committed
is still flagged. Roles only; no names.
"""

import importlib

import pytest

chat_helpers = importlib.import_module("routes.chat_helpers")

_LIVE = {"phase": "veto-competition", "week": 2, "hoh": "npc:1", "hohName": "the HOH",
         "noms": ["npc:2", "npc:3"], "nomNames": ["Nominee One", "Nominee Two"],
         "vetoHolder": None, "vetoHolderName": None, "evicted": 2, "finished": False, "pending": None}

NOT_A_DENIAL = [
    "Imagine the nominees aren't set yet.",                       # A80's first line
    "Nobody says the nominees haven't been named.",                # A80's second line
    "Suppose the nominees aren't set yet, what then?",
    "Assuming the nominees haven't been named, who goes up?",
    "Just in case the nominees haven't been named, she keeps her options open.",
    "She pretends the nominees haven't been named, just to see who flinches.",
    "No one claims the nominees haven't been named.",
]

STALE_DENIALS = [
    "The nominees haven't been named yet.",
    "Nominations haven't been made yet, so the house is on edge.",
    "Before she names her nominees, she wants one more conversation.",
]


@pytest.mark.parametrize("line", NOT_A_DENIAL)
def test_a_hypothetical_or_negated_report_is_not_a_stale_denial(line):
    assert chat_helpers._stale_denial_contradiction(line, dict(_LIVE)) is None, line


@pytest.mark.parametrize("line", STALE_DENIALS)
def test_a_real_stale_denial_is_still_flagged(line):
    assert chat_helpers._stale_denial_contradiction(line, dict(_LIVE)), line


def test_no_committed_nominees_means_no_stale_denial():
    live = dict(_LIVE, noms=[], nomNames=[], phase="nominations")
    assert chat_helpers._stale_denial_contradiction("The nominees haven't been named yet.", live) is None


@pytest.mark.parametrize("line", NOT_A_DENIAL[:2])
def test_the_board_verify_does_not_cut_the_scene_for_a_hypothetical(line):
    """N-3 feeds `_narration_claims_outcome`, which the scene circuit-breaker uses to cut the whole scene."""
    assert chat_helpers._narration_claims_outcome(line, dict(_LIVE), dict(_LIVE)) is None


def test_the_board_verify_still_catches_a_real_stale_denial():
    assert chat_helpers._narration_claims_outcome("The nominees haven't been named yet.", dict(_LIVE), dict(_LIVE))


# The cue list is shared: N-1 (wrong veto winner), the phantom veto-possession check and the aside checks read the same
# `_VETO_N1_HYP_RE`. The new cues must stand those down on a supposition / negated report too, and a plain claim must
# still be caught there.
_NO_HOLDER = dict(_LIVE, vetoHolder=None, vetoHolderName=None)


@pytest.mark.parametrize("line", [
    "Imagine him holding the veto.",
    "Nobody says she won the veto.",
    "She pretends she won the veto, just to rattle the room.",
])
def test_the_shared_cues_stand_down_the_veto_possession_check(line):
    assert chat_helpers._veto_possession_without_holder(line, dict(_NO_HOLDER)) is None, line


@pytest.mark.parametrize("line", ["He is holding the veto.", "She won the veto."])
def test_a_plain_veto_possession_claim_is_still_caught(line):
    assert chat_helpers._veto_possession_without_holder(line, dict(_NO_HOLDER)), line


def test_a_supposition_in_an_earlier_clause_does_not_hide_a_real_denial():
    """The exemption stays scoped to the denial's own clause: a hypothetical first clause cannot cover a later claim."""
    line = "Imagine the look on her face, but the nominees haven't been named yet."
    assert chat_helpers._stale_denial_contradiction(line, dict(_LIVE))

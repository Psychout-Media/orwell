"""A17 - the A-9 unsettled-competition screen must not strip TRUE results of already-committed Final HOH parts.

The three-part Final HOH keeps the structural phase `hoh-competition` while Parts 1 and 2 commit, so the screen's
"nothing progressed" baseline (phase/pending/hoh/compSig) is equal on a turn that merely RECAPS a part that the engine
already settled. The open pending carries the live `finalHohPart`; parts below it are committed and may be voiced.
A result for the live part (or a later one) is still a phantom. Roles only.
"""
import importlib

import pytest

ch = importlib.import_module("routes.chat_helpers")


def _sig(part=2, *, pending="comp-round", comp="npc:1,npc:2"):
    return {"week": 1, "phase": "hoh-competition", "pending": pending, "hoh": None, "hohName": None, "noms": [],
            "vetoHolder": None, "playerIsHoh": None, "playerHasVeto": None, "playerStatus": "active",
            "evicted": 0, "finished": False, "beatSeq": 7, "compSig": comp, "finalHohPart": part}


@pytest.mark.parametrize("recap", [
    "Contestant Alpha wins Part 1 of the final Head of Household and skips straight to Part 3.",
    "Alpha took Part 1 of the final HOH, and now it is down to you and Beta.",
    "Alpha won the first part of the final Head of Household.",
])
def test_committed_part_one_recap_is_voiced_while_part_two_is_pending(recap):
    s = _sig(2)
    assert ch._unsettled_competition_result(recap, s, s) is None


def test_committed_part_two_recap_is_voiced_while_part_three_is_pending():
    s = _sig(3)
    assert ch._unsettled_competition_result("Beta wins Part 2 of the final Head of Household.", s, s) is None


@pytest.mark.parametrize("phantom,part", [
    ("Beta wins Part 2 of the final Head of Household.", 2),          # the LIVE part is still unsettled
    ("Beta takes Part 3 and the final Head of Household!", 2),        # a LATER part
    ("Alpha wins Part 1 of the final Head of Household.", 1),         # nothing committed yet
    ("Beta wins the final Head of Household.", 2),                    # no part cited at all
])
def test_the_live_or_later_part_result_is_still_a_phantom(phantom, part):
    s = _sig(part)
    assert ch._unsettled_competition_result(phantom, s, s)


def test_no_part_in_state_is_the_old_behaviour():
    s = _sig(None)
    assert ch._unsettled_competition_result("Alpha wins Part 1 of the final Head of Household.", s, s)


def test_live_dict_carries_the_part_from_the_open_pending():
    pend = {"kind": "comp-round", "finalHohPart": 2, "stillIn": [{"id": "a"}, {"id": "b"}]}
    assert ch._final_hoh_part({"pending": pend}, {}) == 2
    assert ch._final_hoh_part({}, {"pending": {"kind": "comp-intent"}}) is None

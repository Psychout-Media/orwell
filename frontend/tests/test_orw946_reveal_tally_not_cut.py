"""ORW-946 (Fable week 2, turn 335): the model wrote the whole eviction reveal right after advanceGame committed it ("Three to evict <nominee>. Ten to evict <evictee>. <evictee> is evicted."), the circuit-breaker read
"to evict <the nominee who was NOT evicted>" as a WRONG evictee, cut the scene to its first 110 characters and queued a false "you named the wrong evictee" re-ground. The engine's own TALLY line is written "3 to evict X"
(no noun), and only "N votes to evict X" was a sanctioned count phrase. A count that is one of the engine's revealed ballot counts, naming a current nominee, is the reveal, with or without "votes". Roles only."""
import importlib

import pytest

ch = importlib.import_module("routes.chat_helpers")

NOM_A, NOM_B = "Role Alpha", "Role Bravo"


def _sigs(evicted_after=True):
    before = {"phase": "eviction", "evicted": 0, "evictedNames": [], "activeNames": [NOM_A, NOM_B, "Role Charlie"], "nomNames": [NOM_A, NOM_B]}
    after = {"phase": "eviction", "evicted": 1 if evicted_after else 0, "evictedNames": [NOM_B] if evicted_after else [], "activeNames": [NOM_A, "Role Charlie"],
             "nomNames": [NOM_A, NOM_B], "ballotCounts": [10, 3], "evictionEvictee": NOM_B if evicted_after else None}
    return before, after


@pytest.mark.parametrize("text", [
    f"The host reads the count. Three to evict {NOM_A}. Ten to evict {NOM_B}. {NOM_B} is evicted.",
    f"3 to evict {NOM_A}, 10 to evict {NOM_B}. {NOM_B} has been evicted by the house.",
    f"Three votes to evict {NOM_A}. Ten votes to evict {NOM_B}. {NOM_B} is evicted.",
    f"Three to evict {NOM_A}, a long list: Ten to evict {NOM_B}. The host says {NOM_B} is out.",
])
def test_the_reveal_with_the_engines_counts_is_not_held(text):
    before, after = _sigs()
    assert ch._narration_claims_outcome(text, before, after) is None


def test_a_count_the_engine_never_revealed_is_still_a_fabrication():
    before, after = _sigs()
    verdict = ch._narration_claims_outcome(f"Seven to evict {NOM_A}. Six to evict {NOM_B}. {NOM_B} is evicted.", before, after)
    assert verdict, "a tally that is not the engine's ballot counts still trips the guard"


def test_a_wrong_evictee_is_still_caught():
    before, after = _sigs()
    verdict = ch._narration_claims_outcome(f"{NOM_A} is evicted, and walks out.", before, after)
    assert verdict and "WRONG evictee" in verdict

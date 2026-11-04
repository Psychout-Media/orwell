"""P3 live finding (2026-11-04): the one-turn reveal makes the pre-resolve commit the eviction at FRAMING, so the narration's before-signature already contains it.
(1) the scene circuit-breaker read "eviction narrated + evicted count unmoved" as a phantom and cut the whole eviction scene; (2) the presence wall dropped every
sentence placing the just-evicted houseguest in the room (the ballot readout, the result line), leaving `"*` stubs. Both must treat tonight's COMMITTED evictee as
real and present until they walk out. Roles only."""
import asyncio
import importlib

import pytest

ch = importlib.import_module("routes.chat_helpers")


def _sig(**kw):
    base = {"phase": "eviction", "evicted": 1, "evictedNames": ["Evictee Person"], "evictionEvictee": "Evictee Person", "ballotCounts": [9, 3], "week": 1,
            "pending": None, "finished": False, "nomNames": ["Evictee Person", "Other Nominee"], "activeNames": ["Other Nominee", "Hoh Person", "Voter One"],
            "hohName": "Hoh Person"}
    base.update(kw)
    return base


def test_a_committed_eviction_narrated_in_the_same_turn_is_not_a_phantom():
    s = _sig()
    for t in ['*"Evictee Person, by the vote of the house, you have been evicted from the Big Brother house."*',
              "The door closes behind the evictee, and the house exhales.", "Production: you have been evicted."]:
        assert not ch._narration_claims_outcome(t, s, s), t


def test_naming_an_ACTIVE_houseguest_as_the_evictee_is_still_flagged():
    s = _sig()
    assert ch._narration_claims_outcome('*"Other Nominee, you have been evicted from the Big Brother house."*', s, s)


def test_an_eviction_claimed_when_nothing_was_committed_is_still_flagged():
    s = _sig(evictionEvictee=None, evictedNames=[])
    assert ch._narration_claims_outcome('*"Other Nominee, you have been evicted from the Big Brother house."*', s, s)
    assert ch._narration_claims_outcome("The door closes behind her. You have been evicted.", s, s)


def test_presence_facts_treat_tonights_evictee_as_present_until_they_leave():
    state = {"whereabouts": {"room": "living-room", "present": [{"name": "Hoh Person"}], "nearby": []},
             "house": [{"name": "Hoh Person", "status": "active"}, {"name": "Evictee Person", "status": "evicted"}, {"name": "Earlier Evictee", "status": "evicted"}],
             "eviction": {"stage": "goodbye", "nominees": [], "votesRevealed": [], "evictee": {"id": "npc:1", "name": "Evictee Person"}}}
    f = ch._presence_facts(state)
    assert "Evictee Person" in f["in_view"] and "Evictee Person" not in f["evicted"]
    assert "Earlier Evictee" in f["evicted"], "an evictee from an earlier week is still gone"
    # and with no tonight-eviction the evictee is absent as before
    state2 = dict(state); state2.pop("eviction")
    assert "Evictee Person" in ch._presence_facts(state2)["evicted"]


def test_the_beat_signature_carries_tonights_evictee():
    status = {"week": 1, "phase": "eviction", "hoh": None, "nominees": [], "veto": {"holder": None, "used": False}, "pending": None}
    state = {"finished": False, "house": [], "eviction": {"stage": "goodbye", "nominees": [], "votesRevealed": [], "evictee": {"id": "npc:1", "name": "Evictee Person"}}}
    assert ch._beat_signature(status, state)["evictionEvictee"] == "Evictee Person"
    assert ch._beat_signature(status, {"finished": False, "house": []})["evictionEvictee"] is None


def test_a_recap_sentence_naming_the_committed_evictee_and_an_active_bystander_is_fine():
    s = _sig()
    assert not ch._narration_claims_outcome("Hoh Person watches as Evictee Person is evicted from the house.", s, s)

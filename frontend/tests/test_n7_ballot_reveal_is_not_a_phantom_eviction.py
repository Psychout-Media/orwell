"""A-14 N-7 — the eviction moment prompt tells the narrator to voice each anonymized ballot as "a vote to evict
<nominee>", but the outcome guard read that exact phrase as a phantom EVICTION and dropped it, so the staged
reveal reached the player as "the first ballot comes through, flat and anonymous:" followed by nothing. An
anonymized ballot naming a current NOMINEE during the eviction phase is the sanctioned reveal, not an eviction
claim; the real eviction claim, a tally and a non-nominee still trip. Roles only."""
import importlib

importlib.import_module("src.agent_tools")
ch = importlib.import_module("routes.chat_helpers")


def sig(**kw):
    base = {"phase": "eviction", "week": 1, "hoh": "npc:5", "hohName": "Alpha", "noms": ["npc:2", "npc:4"],
            "nomNames": ["Bravo", "Charlie"], "evicted": 0, "vetoHolder": None, "vetoHolderName": None,
            "activeNames": ["Alpha", "Bravo", "Charlie", "Delta"], "playerId": "player"}
    base.update(kw)
    return base


def verdict(t, s=None):
    s = s or sig()
    return ch._narration_claims_outcome(t, s, s)


def test_an_anonymized_ballot_for_a_nominee_is_allowed_in_every_phrasing_the_prompt_invites():
    for t in ("The voice comes through the speaker: a vote to evict Bravo.",
              "The first ballot reads: \"A vote to evict Charlie.\"",
              "Another vote to evict Bravo. The room doesn't breathe.",
              "The next ballot: a vote to evict Charlie."):
        assert not verdict(t), t


def test_the_eviction_result_a_tally_and_a_non_nominee_still_trip():
    assert verdict("Production: Bravo, you have been evicted from the Big Brother house.")
    assert verdict("The votes are in: Bravo, four to two.")
    assert verdict("The voice comes through: a vote to evict Delta.")          # Delta is not a nominee
    assert verdict("A vote to evict Bravo — and with that, Bravo is evicted.")  # the result clause is still caught


def test_the_ballot_exemption_only_applies_in_the_eviction_phase():
    assert verdict("The voice says: a vote to evict Bravo.", sig(phase="veto-ceremony"))


def test_ballot_phrasing_with_a_voter_attributed_is_not_exempted():
    # E12: ballots are anonymous — a named voter is a different (leak) claim, never the sanctioned reveal
    assert verdict("Delta votes to evict Bravo.")


def test_a_ballot_naming_a_different_person_who_shares_a_first_name_is_not_exempted():
    s = sig(nomNames=["Alex Smith", "Charlie"])
    assert verdict("The voice comes through: a vote to evict Alex Jones.", s)   # not the nominee Alex Smith
    assert not verdict("The voice comes through: a vote to evict Alex Smith.", s)
    assert not verdict("The voice comes through: a vote to evict Alex.", s)      # single-token shorthand of the nominee

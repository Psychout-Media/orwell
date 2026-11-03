"""A-14 N-3 — after the engine COMMITTED a closed-set fact, narration must never say it has NOT happened yet.
Playtest: t18 "the Head of Household competition hasn't happened yet ... production hasn't called anyone to the
backyard" after the engine had run the rounds; t26 "before you name nominees" after the nominations were committed.
The guard compares denials against the signature's committed fields. Roles only (no real names)."""
import importlib

importlib.import_module("src.agent_tools")  # prime the agent_tools <-> tool_schemas cycle
ch = importlib.import_module("routes.chat_helpers")


def sig(**kw):
    base = {"phase": "veto-competition", "week": 1, "hoh": "npc:5", "hohName": "Alpha", "noms": ["npc:2", "npc:4"],
            "nomNames": ["Bravo", "Charlie"], "vetoHolder": None, "vetoHolderName": None, "evicted": 0,
            "activeNames": ["Alpha", "Bravo", "Charlie", "Delta"], "playerId": "player"}
    base.update(kw)
    return base


def claims(text, after, before=None):
    return ch._narration_claims_outcome(text, before or after, after)


def test_hoh_denied_after_the_crown_is_flagged():
    for t in ("Nothing's been announced — the Head of Household competition hasn't happened yet.",
              "There is no Head of Household yet; production hasn't called anyone to the backyard.",
              "Nobody has won HOH yet."):
        assert claims(t, sig(phase="nominations")), t


def test_nominations_denied_after_they_are_committed_is_flagged():
    for t in ("Evelyn hasn't named her nominees yet — you still have time to talk her out of it.",
              "You catch her before she names nominees and plead your case.",
              "The nominations haven't been made."):
        assert claims(t, sig()), t


def test_veto_denied_after_the_holder_is_committed_is_flagged():
    after = sig(phase="veto-ceremony", vetoHolder="npc:7", vetoHolderName="Delta")
    for t in ("The veto hasn't been played yet, so nobody holds it.", "Nobody holds the veto."):
        assert claims(t, after), t


def test_denials_are_fine_when_the_fact_is_genuinely_not_committed():
    assert not claims("The Head of Household competition hasn't happened yet.", sig(phase="hoh-competition", hoh=None, hohName=None, noms=[], nomNames=[]))
    assert not claims("She hasn't named her nominees yet.", sig(phase="nominations", noms=[], nomNames=[]))
    assert not claims("The veto hasn't been played yet.", sig(phase="veto-competition"))


def test_past_week_and_hypothetical_and_unrelated_denials_do_not_trigger():
    after = sig(phase="veto-ceremony", vetoHolder="npc:7", vetoHolderName="Delta")
    for t in ("Last week the veto hasn't been played by this point either, remember?",
              "If the nominations haven't been made by tonight, nobody sleeps.",
              "The pool hasn't been cleaned yet and dinner isn't ready.",
              "Nobody has said a word about the veto since Alpha stormed out."):
        assert not claims(t, after), t


def test_veto_denied_during_the_veto_competition_phase_once_the_holder_is_committed():
    after = sig(phase="veto-competition", vetoHolder="npc:7", vetoHolderName="Delta")
    assert claims("The veto hasn't been played yet — everyone is still waiting in the yard.", after)


def test_nominations_denial_only_polices_phases_after_the_nominations_ceremony():
    # documents the scope: while the engine is still IN the nominations phase the board may be mid-flip, so stand down
    assert not claims("She hasn't named her nominees yet.", sig(phase="nominations"))

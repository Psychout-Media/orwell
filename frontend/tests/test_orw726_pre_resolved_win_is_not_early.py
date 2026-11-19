"""ORW-726: a competition win the FE pre-resolve committed THIS turn (the engine walked the comp to its result before the narrator spoke) must be tellable.
The post-framing baseline already holds the new holder, so before == after on the holder; the verifier read the narrated win as 'one beat early' and the
sentence naming the winner was dropped (Fable season 2 week 1: the player's own veto win was never told). A turn whose baseline carries `compWalked` and whose
board holds a committed holder treats the holder as freshly committed. Roles only."""
import importlib

ch = importlib.import_module("routes.chat_helpers")

_TEXT = "Production's voice rolls across the yard: the player wins the Power of Veto."


def _sig(**kw):
    base = {"phase": "veto-ceremony", "vetoHolder": "npc:self", "vetoHolderName": "Player Role", "playerHasVeto": True,
            "hoh": "npc:1", "hohName": "Hoh Role", "noms": ["npc:2", "npc:3"], "vetoUsed": False, "activeNames": ["Player Role", "Hoh Role"]}
    base.update(kw)
    return base


def test_win_walked_this_turn_is_not_a_phantom():
    before, after = _sig(compWalked=True), _sig()
    assert ch._narration_claims_outcome(_TEXT, before, after) is None


def test_same_claim_without_a_walk_still_reads_early():
    assert "POWER OF VETO being won" in ch._narration_claims_outcome(_TEXT, _sig(), _sig())


def test_walk_with_no_committed_holder_is_still_a_phantom():
    before, after = _sig(compWalked=True, vetoHolder=None), _sig(vetoHolder=None, vetoHolderName=None, playerHasVeto=False, phase="veto-competition")
    assert ch._narration_claims_outcome(_TEXT, before, after)


def test_walked_win_named_wrong_still_caught():
    wrong = "Production's voice rolls across the yard: Hoh Role wins the Power of Veto."
    out = ch._narration_claims_outcome(wrong, _sig(compWalked=True), _sig())
    assert out and "WRONG" in out


def test_before_is_not_mutated():
    b = _sig(compWalked=True)
    ch._narration_claims_outcome(_TEXT, b, _sig())
    assert b["vetoHolder"] == "npc:self"

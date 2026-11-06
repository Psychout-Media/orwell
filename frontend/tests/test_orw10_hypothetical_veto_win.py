"""ORW-10 (live replay 7, 03:19 UTC): '"If I won the veto and you were on the block." He says it back to you slowly.' was cut as 'a phantom POWER OF VETO win'. A hypothetical is not a committed claim. Roles only."""
import importlib

chat_helpers = importlib.import_module("routes.chat_helpers")


def _sig(**o):
    b = {"week": 1, "phase": "veto-competition", "pending": None, "hoh": "npc:1", "hohName": "Marcus", "noms": ["npc:2", "npc:3"], "nomNames": ["Sofia", "Mario"],
         "activeNames": ["Sofia", "Mario", "Marcus", "Nina", "Sam"], "vetoHolder": None, "vetoHolderName": None, "vetoUsed": False,
         "playerIsHoh": False, "playerHasVeto": False, "evicted": 0, "evictedNames": [], "finished": False, "room": "kitchen", "present": []}
    b.update(o)
    return b


def test_a_hypothetical_veto_win_is_not_a_phantom_veto_win():
    s = _sig()
    assert chat_helpers._narration_claims_outcome('"If I won the veto and you were on the block." He says it back to you slowly.', s, s) is None


def test_a_plain_veto_win_claim_is_still_flagged():
    s = _sig()
    d = chat_helpers._narration_claims_outcome("You won the veto! The yard erupts.", s, s)
    assert d and "VETO" in d.upper()


def test_a_hypothetical_does_not_excuse_a_separate_real_claim():
    s = _sig()
    d = chat_helpers._narration_claims_outcome("If it came to that, you'd fight. You won the veto! The yard erupts.", s, s)
    assert d and "VETO" in d.upper()

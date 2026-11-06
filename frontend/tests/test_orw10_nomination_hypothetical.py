"""ORW-10 (live replay 7, 02:40 UTC): the persisted cut log showed a scene cut as 'a phantom NOMINATION' for dialogue that was only a hypothetical: "If it got to that, and you were on the block, and I had the power to pull you
down?" (nominations beat, no nominees committed yet). Speculation is not a committed-nomination claim. Roles only."""
import importlib

chat_helpers = importlib.import_module("routes.chat_helpers")


def _sig(**o):
    b = {"week": 1, "phase": "nominations", "pending": None, "hoh": "npc:1", "hohName": "Marcus", "noms": [], "nomNames": [],
         "activeNames": ["Sofia", "Mario", "Marcus", "Nina", "Sam"], "vetoHolder": None, "vetoHolderName": None, "vetoUsed": False,
         "playerIsHoh": False, "playerHasVeto": False, "evicted": 0, "evictedNames": [], "finished": False, "room": "kitchen", "present": []}
    b.update(o)
    return b


def test_a_hypothetical_about_the_block_is_not_a_phantom_nomination():
    s = _sig()
    for text in ('"If it got to that, and you were on the block, and I had the power to pull you down?" She nods, slow and deliberate.',
                 "Suppose Marcus nominated you - what would you do?", "Imagine you were put on the block this week."):
        assert chat_helpers._narration_claims_outcome(text, s, s) is None, text


def test_a_plain_nomination_claim_with_no_nominees_is_still_flagged():
    s = _sig()
    d = chat_helpers._narration_claims_outcome("Marcus nominates Sofia and Mario for eviction.", s, s)
    assert d and "NOMINATION" in d


def test_a_hypothetical_sentence_does_not_excuse_a_separate_real_claim():
    s = _sig()
    d = chat_helpers._narration_claims_outcome("If it came to that, you'd fight. Marcus nominated Sofia and Mario.", s, s)
    assert d and "NOMINATION" in d

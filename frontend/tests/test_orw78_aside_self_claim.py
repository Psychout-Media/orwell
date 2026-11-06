"""ORW-78 / A94 (live replay 7, 03:33 UTC): the narrator wrote false premises into ((production asides)) that named nobody - "((You're the veto holder - you won it. There's nobody else to ask.))" and "((You're the one holding the veto -
nobody else won it.))" - while the engine had no veto holder and the player held nothing. The name-based aside check never ran, and the next turn narrated the veto meeting as over and slept the night. The PLAYER as subject is now
checked against `playerHasVeto` / `playerIsHoh`. Hypotheticals stay exempt. Roles only."""
import importlib

chat_helpers = importlib.import_module("routes.chat_helpers")


def _live(**o):
    b = {"week": 1, "phase": "veto-competition", "vetoHolder": None, "vetoHolderName": None, "playerHasVeto": False, "playerIsHoh": False,
         "hohName": "Marcus", "nomNames": ["Sofia", "Mario"], "activeNames": ["Sofia", "Mario", "Marcus", "Nina"]}
    b.update(o)
    return b


def test_the_live_aside_texts_are_board_claims_that_contradict_the_board():
    for s in ("You're the veto holder — you won it.", "You're the one holding the veto — nobody else won it."):
        assert chat_helpers._aside_sentence_makes_board_claim(s), s
        assert chat_helpers._aside_claim_contradicts_board(s, _live()), s


def test_a_true_self_claim_and_hypotheticals_stand():
    assert not chat_helpers._aside_claim_contradicts_board("You're the veto holder — you won it.", _live(playerHasVeto=True, vetoHolderName="The Player", vetoHolder="player"))
    for s in ("If you won the veto you could save Sofia.", "When you win the veto, you will have to decide.", "You could be the veto holder by tonight."):
        assert not chat_helpers._aside_claim_contradicts_board(s, _live()), s


def test_a_self_hoh_claim_is_checked_the_same_way():
    assert chat_helpers._aside_claim_contradicts_board("You're the HOH now.", _live())
    assert not chat_helpers._aside_claim_contradicts_board("You're the HOH now.", _live(playerIsHoh=True))

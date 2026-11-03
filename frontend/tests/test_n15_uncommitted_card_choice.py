"""A-14 N-15 — while a card-gated decision is still PENDING (the player has not committed it through the card), the
narrator must not claim the player's choice is made: "You have cast your vote ...", "your ballot is in", "you use the
veto". Big choices bind ONLY via the card (owner ruling); a narrated-but-unrecorded choice is the red line. Closed-set
claims only, screened against the signature's `pending` kind. Roles only."""
import importlib

importlib.import_module("src.agent_tools")
ch = importlib.import_module("routes.chat_helpers")


def sig(**kw):
    base = {"phase": "eviction", "week": 1, "hoh": "npc:5", "hohName": "Alpha", "noms": ["npc:2", "npc:4"],
            "nomNames": ["Bravo", "Charlie"], "evicted": 0, "vetoHolder": "npc:7", "vetoHolderName": "Delta",
            "activeNames": ["Alpha", "Bravo", "Charlie", "Delta"], "playerId": "player", "pending": "eviction-vote"}
    base.update(kw)
    return base


def verdict(t, **kw):
    s = sig(**kw)
    return ch._narration_claims_outcome(t, s, s)


def test_a_cast_vote_claimed_while_the_vote_card_is_open_is_flagged():
    for t in ('The voice says: "Marcus. You have cast your vote. Please state your reason."',
              "You cast your vote and step back out into the hallway.",
              "Your ballot is in. The door swings open.",
              "You vote to evict Bravo, and the Diary Room goes quiet.",
              "You've voted — now all you can do is wait."):
        assert verdict(t), t


def test_the_same_prose_is_fine_once_nothing_is_pending():
    for t in ("You cast your vote and step back out into the hallway.", "Your ballot is in."):
        assert not verdict(t, pending=None), t


def test_other_card_gated_choices_are_covered_by_their_own_pending_kind():
    assert verdict("You use the veto on Bravo.", phase="veto-ceremony", pending="veto-decision")
    assert verdict("You nominate Bravo and Charlie.", phase="nominations", pending="nominations")
    assert verdict("You name Charlie as the replacement nominee.", phase="veto-ceremony", pending="replacement")
    assert verdict("You cast your jury vote for Bravo.", phase="finale", pending="juror-vote")


def test_prose_about_a_different_decision_or_other_people_or_hypotheticals_does_not_trigger():
    # isolate N-15 from the other (pre-existing) closed-set checks: the function under test must not claim these
    n15 = lambda t, **kw: ch._uncommitted_player_choice(t, sig(**kw))
    assert not n15("The rest of the house has cast their votes; yours is the last one.")        # not the player's choice
    assert not n15("Bravo says she hopes you will vote to evict Charlie.")                       # a hope, not a claim
    assert not n15("If you cast your vote now, there is no taking it back.")                    # hypothetical
    assert not n15("You use the veto on Bravo.")                                                 # a different card is open
    assert not n15("The voice asks you to cast your vote.")                                       # an invitation, not a claim
    assert not n15("When you cast your vote, the camera light turns red.")                       # temporal, not a claim


def test_the_claims_are_part_of_the_cheap_closed_set_gate():
    assert ch._sentence_has_closed_set_claim("You have cast your vote.")

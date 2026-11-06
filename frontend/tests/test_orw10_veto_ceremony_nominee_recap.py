"""ORW-10 (live replay 5, 2026-11-06): at the veto ceremony the nominees are ALREADY on the block, so ordinary scene prose that mentions them ("on the block", "nominated") is a RECAP, not a
phantom nomination. NARR-8 branch (5) of `_narration_claims_outcome` flagged every such scene (nominee set unchanged this turn) and the scene circuit-breaker cut it, six scenes running (00:47-00:52);
the re-ground it queued ("you narrated a NOMINATION the engine never committed") then taught the narrator to answer in one-line "((mid-veto ...))" fragments for ~35 messages.
Contract: in the veto-ceremony phases a nomination claim is only suspect when it claims a REPLACEMENT (the one nomination the ceremony can really commit); in the nomination beat itself the old rule stands.
Roles only (throwaway names inside narration strings, as the sibling suite does)."""
import importlib

chat_helpers = importlib.import_module("routes.chat_helpers")


def _sig(**over):
    base = {
        "week": 1, "phase": "veto-ceremony", "pending": None,
        "hoh": "npc:1", "hohName": "Marcus",
        "noms": ["npc:2", "npc:3"], "nomNames": ["Sofia", "Mario"],
        "activeNames": ["Sofia", "Mario", "Marcus", "Nina", "Sam"],
        "vetoHolder": "npc:4", "vetoHolderName": "Nina", "vetoUsed": False,
        "playerIsHoh": False, "playerHasVeto": False,
        "evicted": 0, "evictedNames": [], "finished": False, "room": "kitchen", "present": [],
    }
    base.update(over)
    return base


def test_recap_of_existing_nominees_at_the_veto_ceremony_is_not_a_phantom_nomination():
    s = _sig()
    for text in (
        "Sofia and Mario are still on the block, and Nina hasn't said what she'll do with the veto.",
        "Marcus nominated them two days ago, and the whole house is thinking about it.",
        "Everyone in the yard is watching the two nominees, Sofia and Mario, wait for the ceremony.",
    ):
        assert chat_helpers._narration_claims_outcome(text, s, s) is None, text


def test_a_replacement_nominee_claim_with_no_commit_is_still_flagged_at_the_veto_ceremony():
    s = _sig()
    d = chat_helpers._narration_claims_outcome("Marcus names Sam as the replacement nominee, putting him on the block.", s, s)
    assert d and "NOMINATION" in d


def test_the_nomination_beat_keeps_the_original_rule():
    s = _sig(phase="nominations", noms=[], nomNames=[], vetoHolder=None, vetoHolderName=None)
    d = chat_helpers._narration_claims_outcome("Marcus nominates Sofia and Mario for eviction.", s, s)
    assert d and "NOMINATION" in d


# ── ORW-10 item 1: the wrong competition winner named AFTER the veto beat (live replay 5, turn 1169) ───────────────────────────────────────────────
def test_wrong_winner_named_in_a_replayed_finish_after_the_veto_beat_is_flagged():
    s = _sig(phase="eviction", vetoHolder="npc:4", vetoHolderName="Nina", noms=["npc:2", "npc:3"], nomNames=["Sofia", "Mario"])
    text = ("The rig comes down to the last two, and then it comes down to one.\nIt's Sofia.\n"
            "She gets there by not being fast and not being clever - she gets there by not letting go, long after Marcus's grip finally fails.")
    d = chat_helpers._narration_claims_outcome(text, s, s)
    assert d and "WRONG houseguest" in d and "Nina" in d


def test_the_committed_holder_named_in_a_replayed_finish_is_not_flagged():
    s = _sig(phase="eviction", vetoHolder="npc:4", vetoHolderName="Nina")
    text = "The rig comes down to the last two, and then it comes down to one.\nIt's Nina.\nShe outlasts everyone."
    assert chat_helpers._narration_claims_outcome(text, s, s) is None


def test_ordinary_its_name_prose_with_no_finish_cue_is_untouched():
    s = _sig(phase="eviction", vetoHolder="npc:4", vetoHolderName="Nina")
    assert chat_helpers._narration_claims_outcome("It's Sofia at the door, hands shaking, asking to talk.", s, s) is None

"""N-1 (A-14 playtest): after a veto competition the narration named the WRONG houseguest as the veto winner and as
using it, contradicting the engine (holder = a different houseguest; the named one was eliminated in the comp).
The F-3 screen covers the veto FIELD and A-9 only arms while the comp is unsettled; this pins the settled-holder
WINNER / USE screen. Closed-set claims only. Roles only."""
import importlib

ch = importlib.import_module("routes.chat_helpers")

ACTIVE = ["Holder", "Rival", "Bystander", "Playerone"]


def _sig(**kw):
    base = {"week": 1, "phase": "veto-ceremony", "pending": None, "hoh": "npc:7", "hohName": "Hoh", "noms": [],
            "vetoHolder": "npc:1", "vetoHolderName": "Holder", "vetoUsed": False, "playerIsHoh": False,
            "playerHasVeto": False, "playerStatus": "active", "evicted": 0, "finished": False, "beatSeq": 40,
            "compSig": None, "vetoFieldIds": [], "vetoFieldNames": [], "playerId": "player",
            "activeNames": ACTIVE}
    base.update(kw)
    return base


LIVE_LEAK = ('Rival gets there first. His hand comes down and the bell rings. "That\'s mine?"\n\n'
             'Rival: "I\'m gonna use it. I\'m taking Bystander down."')


def test_the_captured_leak_is_flagged():
    label = ch._veto_holder_contradiction(LIVE_LEAK, _sig())
    assert label and "Holder" in label
    directive = ch._narration_claims_outcome(LIVE_LEAK, _sig(), _sig())
    assert directive and "RE-GROUND" in directive


def test_winner_claims_naming_a_non_holder_are_flagged():
    for t in ("Rival gets there first and the bell rings.", "Rival wins the veto.", "Rival takes the Power of Veto.",
              "Rival claims the power of veto with a grin."):
        assert ch._veto_holder_contradiction(t, _sig()), t


def test_use_claims_by_a_non_holder_are_flagged():
    for t in ('Rival: "I\'m gonna use it on myself." The veto glints.', "Rival is going to use the veto tonight.",
              "Rival will use the Power of Veto on Bystander."):
        assert ch._veto_holder_contradiction(t, _sig()), t


def test_the_gate_lets_the_new_cues_reach_the_board_check():
    assert ch._sentence_has_closed_set_claim("Rival gets there first and the bell rings.") is True
    assert ch._sentence_has_closed_set_claim('Rival: "I\'m gonna use it." The veto waits.') is True


def test_negatives_never_trigger():
    ok = (
        "Holder gets there first and the bell rings.",                       # the actual holder
        'Holder: "I\'m gonna use it." The veto glints.',
        "Last week Rival won the veto and used it.",                          # past
        "If Rival wins the veto, the whole week flips.",                      # hypothetical
        "Whoever wins the veto, Rival hopes it is not Holder.",
        "Rival wonders whether Rival will use the veto.",
        "Rival gets there first to the kitchen and grabs a snack.",           # no comp context
        "The bell rings and the sweat runs. The yard is tense.",              # generic texture
        "Someone gets there first and the bell rings.",                       # not a houseguest
        'Rival: "I\'m gonna use the bathroom."',
    )
    for t in ok:
        assert ch._veto_holder_contradiction(t, _sig()) is None, t
        if "wins the veto" not in t:   # the pre-existing NARR-8 branch owns bare 'wins the veto' (unchanged)
            assert ch._narration_claims_outcome(t, _sig(), _sig()) is None, t


def test_stands_down_without_a_committed_holder_or_in_other_phases():
    # (d) no holder yet: the existing A-9 behaviour is untouched and the new screen is silent
    s = _sig(vetoHolder=None, vetoHolderName=None, phase="veto-competition")
    assert ch._veto_holder_contradiction(LIVE_LEAK, s) is None
    a9 = "Rival goes out on the third round."
    assert ch._unsettled_competition_result(a9, s, dict(s))
    assert ch._narration_claims_outcome(a9, dict(s), s)
    assert ch._veto_holder_contradiction(LIVE_LEAK, _sig(phase="nominations")) is None
    assert ch._veto_holder_contradiction(LIVE_LEAK, {}) is None

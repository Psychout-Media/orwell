"""ORW-1052: the veto ceremony narration must name the engine's actual veto use (self-save, a saved nominee, not used) and the replacement."""
import pytest

from src import predisplay_check as pc


def _cer(used, saved=None, repl=None, nominees=("Eva McDonald", "Jordan Reyes")):
    node = lambda n: {"id": n, "name": n}
    dec = {"made": True, "used": used}
    if used:
        dec["saved"] = node(saved)
        dec["replacement"] = node(repl)
    return {"hoh": node("Roman Hardwick"), "nominees": [node(n) for n in nominees],
            "veto": {"holder": node("Lesly Fisk"), "decision": dec}}


SELF_SAVE = _cer(True, "Lesly Fisk", "Jordan Reyes")
SAVED_NOMINEE = _cer(True, "Eva McDonald", "Jordan Reyes", nominees=("Lesly Fisk", "Jordan Reyes"))
NOT_USED = _cer(False)


@pytest.mark.parametrize("text", [
    'Lesly Fisk: "I used the veto to take Eva McDonald down."',
    "Eva McDonald is off the block, and the player is on it.",
    "Eva McDonald is no longer nominated.",
    "Lesly Fisk saved Eva McDonald with the veto.",
    "Roman Hardwick names Eva McDonald as the replacement.",
])
def test_self_save_contradicting_statements_are_caught(text):
    assert pc.veto_decision_conflict(text, SELF_SAVE), text
    assert pc.FACT_VETO in pc.find_conflicts(text, {"ceremony": SELF_SAVE}, zero_clocks=False)


@pytest.mark.parametrize("text", [
    "Lesly Fisk took herself down.",
    "Lesly Fisk used the veto on herself.",
    "Roman Hardwick names Jordan Reyes as the replacement.",
    "Lesly Fisk is off the block.",
    "Eva McDonald stays on the block.",
])
def test_self_save_true_statements_are_clean(text):
    assert pc.veto_decision_conflict(text, SELF_SAVE) is None, text


def test_saved_nominee_wrong_and_right():
    assert pc.veto_decision_conflict("Lesly Fisk took herself down.", SAVED_NOMINEE)
    assert pc.veto_decision_conflict("Jordan Reyes is off the block.", SAVED_NOMINEE)
    assert pc.veto_decision_conflict("Lesly Fisk saved Jordan Reyes.", SAVED_NOMINEE)
    assert pc.veto_decision_conflict("Lesly Fisk took Eva McDonald down.", SAVED_NOMINEE) is None
    assert pc.veto_decision_conflict("Eva McDonald is off the block.", SAVED_NOMINEE) is None
    assert pc.veto_decision_conflict("Roman Hardwick names Jordan Reyes as the replacement.", SAVED_NOMINEE) is None


def test_not_used_wrong_and_right():
    assert pc.veto_decision_conflict("Lesly Fisk used the veto on Eva McDonald.", NOT_USED)
    assert pc.veto_decision_conflict("Eva McDonald is off the block.", NOT_USED)
    assert pc.veto_decision_conflict("Lesly Fisk saved Eva McDonald.", NOT_USED)
    assert pc.veto_decision_conflict("Lesly Fisk did not use the veto. Eva McDonald stays on the block.", NOT_USED) is None


def test_replacement_named_wrongly_is_caught():
    assert pc.veto_decision_conflict("Roman Hardwick names Eva McDonald as the replacement.", SAVED_NOMINEE)

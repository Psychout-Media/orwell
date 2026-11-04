"""N-16 (A9 live rerun): the narrator staged the HOH competition on screen (take your spots / climb onto the platform / hands find the wall) while the engine said NOT due and nothing pending
- a narrated-but-unrecorded board event. The pre-emission guard now catches it (conservatively: comp phase, explicit not-due flag, >= 2 distinct cue families). Roles only."""
import importlib

ch = importlib.import_module("routes.chat_helpers")

STARTED = ('"Locked in. Houseguests - take your spots." The yard moves. Sixteen bodies climb onto the platform, sixteen sets of hands find the wall, '
           "and the rope line goes taut.")


def _sig(phase="hoh-competition", not_due=True, pending=None):
    return {"week": 1, "phase": phase, "pending": pending, "compNotDue": not_due, "evicted": 0, "finished": False, "activeNames": [], "noms": []}


def _directive(text, after, before=None):
    return ch._narration_claims_outcome(text, before or after, after)


def test_started_comp_while_not_due_is_caught():
    assert _directive(STARTED, _sig()) is not None
    assert "NOT due" in (_directive(STARTED, _sig()) or "")


def test_due_or_pending_or_unknown_schedule_stands_down():
    assert _directive(STARTED, _sig(not_due=False)) is None, "due: the comp may start"
    assert _directive(STARTED, _sig(pending="comp-round")) is None, "an open comp decision: the comp is live"
    assert _directive(STARTED, _sig(not_due=None)) is None, "no schedule (clock off): never judge"
    assert _directive(STARTED, _sig(phase="nominations")) is None, "only the competition phases"


def test_one_cue_family_is_not_enough():
    assert _directive('Production\'s voice: "Take your spots, everyone, in an hour."', _sig()) is None
    assert _directive("The kitchen is loud and the screens flicker with a replay of last night.", _sig()) is None


def test_ordinary_social_narration_is_untouched():
    social = "The morning slides by. Coffee goes cold, a card game starts at the counter, and Brock tells the eggs story again."
    assert _directive(social, _sig()) is None


def test_signature_derives_the_not_due_flag():
    st = {"phase": "hoh-competition", "daySchedule": {"next": "hoh-competition", "phase": "afternoon", "due": False, "minutesUntil": 70}}
    assert ch._beat_signature({"phase": "hoh-competition"}, st)["compNotDue"] is True
    st["daySchedule"]["due"] = True
    assert ch._beat_signature({"phase": "hoh-competition"}, st)["compNotDue"] is False
    assert ch._beat_signature({"phase": "hoh-competition"}, {"phase": "hoh-competition"})["compNotDue"] is None

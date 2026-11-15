"""ORW-273 - scene-cut causes: two false-positive classes in the A-9 'unsettled competition' screen, and the cutaway line.

(1) The pre-resolve walks the staged rounds and PAUSES BEFORE the baseline signature is captured, so before == live while the narrator is
    (correctly) voicing the rounds the engine just walked. A crowd reaction ('The yard erupts.') or a round drop was cut as a phantom. The
    baseline now carries `compWalked`; round-level cues stand down, a WINNER / crown claim still cuts (the paused tail forbids it).
(2) A pronoun is not a houseguest: 'He goes down hard on the plank.' matched the named-elimination regex ('He' read as a name).
(3) The cutaway line must not assert a room state ('the empty backyard') - the yard is full during a competition. Roles only."""
import importlib

ch = importlib.import_module("routes.chat_helpers")
al = importlib.import_module("src.agent_loop")


def _sig(**kw):
    s = {"week": 1, "phase": "hoh-competition", "pending": "comp-round", "hoh": None, "hohName": None, "noms": [], "vetoHolder": None,
         "playerIsHoh": None, "playerHasVeto": None, "playerStatus": "active", "evicted": 0, "finished": False, "beatSeq": 7,
         "compSig": "npc:1,npc:2"}
    s.update(kw)
    return s


def test_pronoun_elimination_is_not_a_named_claim():
    t = "He goes down hard on the plank, both knees, and stays there."
    assert ch._unsettled_competition_result(t, _sig(), _sig()) is None


def test_named_elimination_is_still_caught_before_any_round_was_walked():
    assert ch._unsettled_competition_result("Contestant Alpha goes out first, laughing it off.", _sig(), _sig())


def test_crowd_reaction_after_walked_rounds_is_not_a_phantom():
    t = "The yard erupts - and then the noise shifts, because everyone is doing the same math at once."
    assert ch._unsettled_competition_result(t, _sig(), _sig()) is not None  # no walk: still the old behavior
    assert ch._unsettled_competition_result(t, _sig(), _sig(compWalked=True)) is None


def test_walked_rounds_may_name_who_fell_but_never_a_winner():
    drop = "Contestant Alpha goes out first, laughing it off."
    assert ch._unsettled_competition_result(drop, _sig(), _sig(compWalked=True)) is None
    win = "Contestant Beta wins Head of Household!"
    assert ch._unsettled_competition_result(win, _sig(), _sig(compWalked=True))
    last = "The last houseguest standing is the first Head of Household of the season."
    assert ch._unsettled_competition_result(last, _sig(), _sig(compWalked=True))


def test_walk_marker_is_one_shot():
    ch.mark_comp_walked("u273")
    assert ch.consume_comp_walked("u273") is True
    assert ch.consume_comp_walked("u273") is False


def test_cutaway_line_asserts_no_room_state():
    line = al._SCENE_CUTAWAY_LINE.lower()
    assert "empty" not in line and "backyard" not in line
    assert "cut away" in line

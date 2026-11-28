"""ORW-1184 / ORW-1187 (ORW-1156 gate corpus): the precision vetoes let a plain own-act through. Synthetic lines only (no player chat). Each MISS list failed on main; each KEEP list is the false-act guard: still vetoed."""
import pytest

from src import act_first as af

CTX = {"here": "living-room", "people": [], "room_names": None, "pending_kind": None, "sleep_ok": True}

MOVE_MISS = [
    ("kitchen", "please go to the kitchen"),
    ("kitchen", "um, I go to the kitchen"),
    ("kitchen", "hmm okay to the kitchen"),
    ("kitchen", "back to the kitchen"),
    ("kitchen", "over to the kitchen"),
    ("kitchen", "into the kitchen"),
    ("backyard", "out to the backyard"),
    ("kitchen", "I go to the kitchen, ok?"),
    ("kitchen", "heading to the kitchen, yeah?"),
    ("kitchen", "going to the kitchen right?"),
    ("kitchen", "sneak into the kitchen"),
    ("kitchen", "step into the kitchen"),
]
MOVE_KEEP = [
    ("kitchen", "can I go to the kitchen?"),
    ("kitchen", "should we go to the kitchen?"),
    ("kitchen", "do I go to the kitchen?"),
    ("kitchen", "she goes to the kitchen"),
    ("kitchen", "Dana went into the kitchen, ok?"),
    ("kitchen", "please don't go to the kitchen"),
    ("kitchen", "to the kitchen later maybe"),
    ("kitchen", "I might go to the kitchen, ok?"),
    ("kitchen", "what about the kitchen?"),
    ("kitchen", "the kitchen is nice"),
]
SLEEP_MISS = ["off to bed", "night everyone", "goodnight all", "bedtime", "nighty night", "calling it a night", "I'm off to bed"]
SLEEP_KEEP = ["is it bedtime?", "Dana says goodnight", "she is off to bed", "I will not go to bed", "what a night", "off to bed? no way"]


@pytest.mark.parametrize("room,text", MOVE_MISS)
def test_plain_own_move_is_not_vetoed(room, text):
    assert not af.room_vetoed(room, text, CTX)


@pytest.mark.parametrize("room,text", MOVE_KEEP)
def test_not_an_act_stays_vetoed(room, text):
    assert af.room_vetoed(room, text, CTX)


@pytest.mark.parametrize("text", SLEEP_MISS)
def test_plain_sleep_act_is_not_step_vetoed(text):
    assert not af.step_vetoed(text, "turnIn")


@pytest.mark.parametrize("text", SLEEP_KEEP)
def test_not_a_sleep_act_stays_step_vetoed(text):
    assert af.step_vetoed(text, "turnIn")

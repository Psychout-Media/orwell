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


def test_can_commit_nothing_notes_the_live_context_by_code_only():
    from src import gate_log
    gate_log.reset()
    ctx = dict(CTX, people=["Kai Lorn", "Mara"])
    af.can_commit_nothing("zzz plain words", ["kitchen", "backyard"], ctx)
    row = gate_log.ctx_of(gate_log.code_of("zzz plain words"))
    assert row["people"] == ["kai", "mara"] and row["rooms"] == ["kitchen", "backyard"] and row["here"] == "living-room"
    assert "zzz" not in repr(gate_log.ctx_export())


def test_corpus_row_replays_with_the_live_roster():
    from src import gate_corpus
    text = "go find kai"  # no capital letter: the offline guess names nobody
    assert gate_corpus.row_for(text, ["search"])["gates"]["search-cue"] is False
    row = gate_corpus.row_for(text, ["search"], live_ctx={"people": ["kai"], "rooms": []})
    assert row["gates"]["search-cue"] is True and row["live"] is True

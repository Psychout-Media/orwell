"""ORW-408: when the presence wall would cut a sentence (someone not in the room speaking), the reply is quietly redone once from what was shown instead; the wall still cuts a redo that is wrong again. Roles only."""
from test_a2_presence_wall import _house, _state
from test_orw408_sentence_rewrite import CLEAN_A, TAIL, _drive, _rewrite_on  # noqa: F401

_BOARD = _state("living-room", present=["Ana Reed"], house=_house(active=["Ana Reed", "Bo Lane"]))
_PHANTOM = 'Bo Lane says, "I was never gone." '
_REDO = "Ana Reed tops up the kettle."


def _run(monkeypatch, redo, **kw):
    from src import orwell_engine as oe

    async def board(user=None, timeout=None):
        return dict(_BOARD)
    monkeypatch.setattr(oe, "get_game_state", board)
    return _drive(monkeypatch, rounds_scripts=[{"deltas": [CLEAN_A, _PHANTOM, TAIL]}], redo=redo, state=_BOARD, **kw)


def test_a_phantom_speaker_is_redone_once_and_the_redo_names_who_is_here(monkeypatch):
    emitted, cont, stored, _ = _run(monkeypatch, _REDO)
    assert "Bo Lane" not in emitted and TAIL.strip() not in emitted
    assert emitted.strip() == (CLEAN_A + _REDO).strip() and stored[0] == emitted.strip()
    assert len(cont) == 1 and "Only Ana Reed is in the room with the player" in cont[0][-1]["content"]


def test_a_redo_that_stages_them_again_is_still_cut_by_the_wall(monkeypatch):
    emitted, cont, _, _ = _run(monkeypatch, "Bo Lane says, \"Still here.\" " + _REDO)
    assert "Bo Lane" not in emitted and _REDO in emitted and len(cont) == 1


def test_with_the_rewrite_off_the_wall_cuts_as_before(monkeypatch):
    emitted, cont, _, _ = _run(monkeypatch, _REDO, flag="0")
    assert "Bo Lane" not in emitted and TAIL.strip() in emitted and cont == []

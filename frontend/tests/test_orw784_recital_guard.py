"""ORW-784 (item 1): a writer-directed instruction fragment never opens the narration the player reads.

Season-2 playtest: three replies opened with a stray instruction fragment glued to the scene ("Keep the answer short and plain in the grey of the ..." and "Verbatim, the fire pit ...").
Real `stream_agent_loop`, stubbed narrator rounds (the test_orw408 harness), roles only."""
import importlib

import pytest

pytestmark = [pytest.mark.usefixtures("non_game_text_routing"), pytest.mark.usefixtures("zero_clocks_off")]

t408 = importlib.import_module("test_orw408_sentence_rewrite")
ledger = importlib.import_module("src.orwell_sync_ledger")
rg = importlib.import_module("src.recital_guard")

OWNER = "orw784"
BODY = "in the grey of the common room, the low light holds the walls and a cup is set down. The room waits."


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    monkeypatch.setenv("ORWELL_PREDISPLAY_REWRITE", "0")
    monkeypatch.delenv("ORWELL_RECITAL_GUARD", raising=False)
    ledger._PENDING_BELTS.clear()
    yield
    ledger._PENDING_BELTS.clear()


def _run(monkeypatch, text):
    return t408._drive(monkeypatch, rounds_scripts=[{"deltas": [text]}], state={"asleep": []}, owner=OWNER)


def test_a_leading_instruction_clause_is_dropped_before_the_player_sees_it(monkeypatch):
    emitted, _c, stored, _n = _run(monkeypatch, "Keep the answer short and plain " + BODY)
    assert "Keep the answer" not in emitted
    assert emitted.lstrip().startswith("In the grey of the common room")
    assert all("Keep the answer" not in s for s in stored), stored
    assert ledger.get_belt_totals(OWNER).get("recital-stripped") == 1


def test_a_leading_stray_adverb_is_dropped(monkeypatch):
    emitted, _c, stored, _n = _run(monkeypatch, "Verbatim, the fire pit keeps its low red seam. The room waits.")
    assert "Verbatim" not in emitted
    assert emitted.lstrip().startswith("The fire pit keeps its low red seam")
    assert all("Verbatim" not in s for s in stored), stored


def test_flag_off_shows_the_fragment_as_today(monkeypatch):
    monkeypatch.setenv("ORWELL_RECITAL_GUARD", "0")
    emitted, _c, _s, _n = _run(monkeypatch, "Verbatim, the fire pit keeps its low red seam. The room waits.")
    assert "Verbatim, the fire pit" in emitted
    assert ledger.get_belt_totals(OWNER) == {}


@pytest.mark.parametrize("text", [
    '"Verbatim, that is what he said," she tells the room. The fire ticks.',
    "The house keeps its answer short and plain, and nobody says more. The fire ticks.",
    "Keeping quiet was the plan. The fire ticks.",
    "He reads the note verbatim, then folds it. The fire ticks.",
])
def test_scene_prose_is_left_alone(monkeypatch, text):
    emitted, _c, _s, _n = _run(monkeypatch, text)
    assert text[:25] in emitted
    assert ledger.get_belt_totals(OWNER) == {}


@pytest.mark.parametrize("s,expected", [
    ("Keep the answer short and plain in the grey", "In the grey"),
    ("Keep the reply brief, plain and quiet at the fire pit", "At the fire pit"),
    ("Verbatim, the fire pit keeps", "The fire pit keeps"),
    ("The fire pit keeps", "The fire pit keeps"),
    ("", ""),
])
def test_strip_cases(s, expected):
    assert rg.strip_leading_recital(s)[0] == expected

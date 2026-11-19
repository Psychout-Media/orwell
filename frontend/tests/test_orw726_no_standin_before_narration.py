"""ORW-726: the engine-authored "live feeds cut away" stand-in is never shown ahead of real narration (Fable season 2: it led three replies that went on to tell
the scene). A cut scene is held, the turn re-voices from engine truth, and only a turn that shows NOTHING falls to the existing engine-board line.
Real `stream_agent_loop`, stubbed narrator rounds (the test_orw408 harness), roles only."""
import importlib

import pytest

pytestmark = [pytest.mark.usefixtures("non_game_text_routing"), pytest.mark.usefixtures("zero_clocks_off")]

t408 = importlib.import_module("test_orw408_sentence_rewrite")

PHANTOM = "Phantom claim of a result the board never reached."
SCENE = "The kitchen is quiet. Rain taps the glass. A cup is set down."
OWNER = "orw726"


@pytest.fixture(autouse=True)
def _cut_phantom(monkeypatch):
    from routes import chat_helpers as ch

    async def screen(user, text):
        return "RE-GROUND: a phantom result" if "Phantom claim" in (text or "") else None
    monkeypatch.setattr(ch, "screen_streamed_scene_break", screen)
    monkeypatch.setenv("ORWELL_PREDISPLAY_REWRITE", "0")


def _run(monkeypatch, scripts):
    return t408._drive(monkeypatch, rounds_scripts=scripts, state={"asleep": []}, owner=OWNER)


def test_a_cut_first_draft_then_a_real_scene_never_shows_the_stand_in(monkeypatch):
    emitted, _c, stored, _n = _run(monkeypatch, [{"deltas": [PHANTOM]}, {"deltas": [SCENE]}])
    assert SCENE in emitted
    assert "live feeds cut away" not in emitted and "control room" not in emitted
    assert all("live feeds cut away" not in s for s in stored), stored


def test_every_draft_cut_still_leaves_the_player_something_that_is_not_the_stand_in(monkeypatch):
    emitted, _c, _s, _n = _run(monkeypatch, [{"deltas": [PHANTOM]}, {"deltas": [PHANTOM]}, {"deltas": [PHANTOM]}])
    assert emitted.strip(), "the existing blank-turn fallback speaks"
    assert "control room" not in emitted and "Phantom claim" not in emitted

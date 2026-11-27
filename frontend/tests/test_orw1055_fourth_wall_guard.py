"""ORW-1055: the fourth-wall guard and the refusal guard beyond the first chunk. Roles only."""
import importlib

import pytest

fw = importlib.import_module("src.fourth_wall_guard")
rg = importlib.import_module("src.refusal_guard")
al = importlib.import_module("src.agent_loop")

SPEECH = 'Ingrid takes her bag. "I have loved this house. This is not the scene we are doing, so restart it elsewhere." She hugs Maya and goes.'


def test_a_goodbye_that_names_the_scene_loses_that_sentence_and_keeps_the_quote_closed():
    kept, n = fw.strip_fourth_wall(SPEECH)
    assert n > 0
    assert "scene" not in kept and "restart" not in kept
    assert "I have loved this house." in kept and "She hugs Maya and goes." in kept
    assert kept.count('"') % 2 == 0, kept


@pytest.mark.parametrize("line", [
    "I will stay in character no matter what.",
    "Let me break character for a moment.",
    "As an AI I cannot do that.",
    "We should redo this scene from the top.",
])
def test_meta_sentences_are_dropped(line):
    assert fw.strip_fourth_wall("The kitchen is quiet. " + line + " Rain taps the glass.")[0] == "The kitchen is quiet. Rain taps the glass."


@pytest.mark.parametrize("line", [
    "The scene in the living room is tense.",
    "She plays a character who never loses.",
    "Maya says the script of the show is not hers.",
    "He is in character for the premiere night.",
])
def test_ordinary_narration_is_untouched(line):
    assert fw.strip_fourth_wall(line) == (line, 0)


def test_refusal_is_dropped_beyond_the_first_chunk():
    text = "The kitchen is quiet. I'm sorry, but I can't continue in this direction. Rain taps the glass."
    kept, n = rg.strip_refusals(text)
    assert n > 0 and "sorry" not in kept and kept.startswith("The kitchen is quiet.") and "Rain taps" in kept
    assert rg.strip_leading_refusal(text)[1] == 0, "the old leading-only strip missed it"


def test_the_round_helpers_screen_a_chunk_after_text_was_emitted_and_log_the_belts():
    led = importlib.import_module("src.orwell_sync_ledger")
    led._PENDING_BELTS.clear()
    chunk = "I'm sorry, but I can't continue in this direction. Rain taps the glass."
    resp, clean, hit = al._withhold_leading_refusal("orw1055", 2, "Earlier text. " + chunk, chunk, "Earlier text. ")
    assert hit and "sorry" not in clean and "sorry" not in resp and "Earlier text." in resp
    chunk2 = 'She says "This is not the scene we are doing." Rain taps the glass.'
    resp2, clean2, hit2 = al._strip_fourth_wall("orw1055", 2, "Earlier. " + chunk2, chunk2)
    assert hit2 and "not the scene" not in clean2 and "not the scene" not in resp2 and "Earlier." in resp2
    totals = led.get_belt_totals("orw1055")
    assert totals.get("refusal-withheld") == 1 and totals.get("fourth-wall-dropped") == 1


def test_guard_off_switch(monkeypatch):
    monkeypatch.setenv("ORWELL_FOURTH_WALL_GUARD", "0")
    assert not fw.enabled()

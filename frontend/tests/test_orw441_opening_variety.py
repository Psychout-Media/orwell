"""Opening variety at the source (no model call): the writer prompts no longer seed "A <age>-year-old" or "He stands", and each
card is dealt an opening pattern by its slot, plus the openings already used in the cast. Roles only."""
import re

from src import orwell_cast_authoring as ca
from src import orwell_cast_gate as gate


def test_the_prompt_no_longer_seeds_the_templates():
    assert "starting with the pronoun" not in ca.PHOTO_SHEET_RULES
    assert 'never open the line with the pronoun and a posture verb' in ca.PHOTO_SHEET_RULES
    assert "OPENING PATTERN" in ca.PHOTO_SHEET_RULES and "do not open it with" in ca._SYSTEM


def test_opening_patterns_rotate_by_slot():
    ids = [ca.opening_pattern(i)["identityConcept opens with"] for i in range(6)]
    cams = [ca.opening_pattern(i)["onCamera opens with"] for i in range(6)]
    assert len(set(ids)) == 6 and len(set(cams)) == 6
    assert ca.opening_pattern(0) == ca.opening_pattern(6)


def _msg(taken):
    npc = {"id": "npc:1", "name": "Namea Surnamea", "genderPresentation": "man", "age": 30, "vocation": "welder", "hometown": "Macon, Georgia"}
    return ca.build_authoring_messages(npc, taken=taken)[-1]["content"]


def test_the_user_prompt_carries_the_slot_pattern_and_the_openings_already_used():
    text = _msg({"vocations": [], "hometowns": [], "openings": ca.opening_pattern(2),
                 "phrases": {"oncamera_openings": ["he stands in", "she leans on"], "identity_openers": ["a 21"]}})
    assert "OPENING PATTERN for this card: identityConcept opens with where they come from" in text
    assert "onCamera lines already open: he stands in | she leans on" in text and "identity lines already open: a 21" in text


def test_a_prompt_without_the_new_taken_keys_is_unchanged():
    base = {"vocations": ["x"], "hometowns": ["y"]}
    assert "OPENING PATTERN" not in _msg(base) and "already open:" not in _msg(base)


def test_the_gate_reports_the_oncamera_openings_taken():
    g = gate.SeasonGate("t")
    npc = {"id": "npc:1", "name": "Namea Surnamea", "genderPresentation": "man", "age": 30}
    prof = {"biography": "Namea welds boats and keeps lists of everything. He sleeps badly on Sundays.", "identityConcept": "Namea welds.",
            "physicalCharacteristics": {"onCamera": "He stands in the kitchen, arms folded."}}
    g.accept("npc:1", prof, npc, [npc])
    assert g.taken_phrases("npc:2")["oncamera_openings"] == ["he stands in"]


def test_the_prompts_forbid_the_name_in_the_oncamera_and_identity_lines():
    assert "Never use the houseguest's name in the onCamera line" in ca.PHOTO_SHEET_RULES
    assert "do not put the person's name in it" in ca._SYSTEM


def _card(cam):
    npc = {"id": "npc:1", "name": "Namea Surnamea", "genderPresentation": "woman", "age": 30}
    prof = {"physicalCharacteristics": {"onCamera": cam}}
    return npc, prof


def test_the_gate_replaces_the_own_name_in_the_oncamera_line_with_the_pronoun():
    for cam, want in (("With a knowing half-smile, Namea stands in the kitchen, hands in her pockets.", "With a knowing half-smile, she stands in the kitchen, hands in her pockets."),
                      ("Namea leans on the counter in the kitchen.", "She leans on the counter in the kitchen."),
                      ("Namea's gaze stays level in the kitchen.", "Her gaze stays level in the kitchen."),
                      ("She stands in the kitchen.", "She stands in the kitchen.")):
        npc, prof = _card(cam)
        codes = gate.mend(prof, npc, [npc])
        assert prof["physicalCharacteristics"]["onCamera"] == want
        assert ("oncamera-name" in codes) == (cam != want)

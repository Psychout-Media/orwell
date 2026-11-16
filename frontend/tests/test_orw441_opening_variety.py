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


def test_a_they_card_gets_a_plural_verb_after_the_pronoun_or_the_safe_wording():
    npc = {"id": "npc:1", "name": "Namea Surnamea", "genderPresentation": "nonbinary", "age": 30}
    cases = [
        ("Namea stands in the kitchen, one hand flat on the counter.", "They stand in the kitchen, one hand flat on the counter."),
        ("With a slow grin, Namea leans on the counter in the kitchen.", "With a slow grin, they lean on the counter in the kitchen."),
        ("Namea is in the backyard, hands in pockets.", "They are in the backyard, hands in pockets."),
        ("Namea quietly watches the room from the lounge.", "They quietly watch the room from the lounge."),
        ("Namea carries a mug into the kitchen.", "They carry a mug into the kitchen."),
        ("Namea has a mug in hand at the kitchen island.", "They have a mug in hand at the kitchen island."),
        ("Namea sat at the kitchen island, chin lifted.", "The houseguest sat at the kitchen island, chin lifted."),
        ("Namea's gaze stays level in the kitchen.", "Their gaze stays level in the kitchen."),
    ]
    for cam, want in cases:
        prof = {"physicalCharacteristics": {"onCamera": cam}}
        gate.mend(prof, npc, [npc])
        assert prof["physicalCharacteristics"]["onCamera"] == want, cam


def test_they_guard_for_s_adverbs_and_a_comma_after_the_name():
    npc = {"id": "npc:1", "name": "Namea Surnamea", "genderPresentation": "nonbinary", "age": 30}
    cases = [
        ("Namea always stands in the kitchen, arms folded.", "They always stand in the kitchen, arms folded."),
        ("Namea sometimes leans on the counter in the kitchen.", "They sometimes lean on the counter in the kitchen."),
        ("Namea perhaps grins in the lounge.", "They perhaps grin in the lounge."),
        ("Namea nevertheless stands in the lounge.", "The houseguest nevertheless stands in the lounge."),
        ("Namea, arms folded, stands in the lounge.", "The houseguest, arms folded, stands in the lounge."),
        ("Hands loose, Namea, arms folded, stands in the lounge.", "Hands loose, the houseguest, arms folded, stands in the lounge."),
    ]
    for cam, want in cases:
        prof = {"physicalCharacteristics": {"onCamera": cam}}
        gate.mend(prof, npc, [npc])
        assert prof["physicalCharacteristics"]["onCamera"] == want, cam


def test_review_of_2781_case_variants_objects_and_conjugation_edges():
    npc = {"id": "npc:1", "name": "Namea Surnamea", "genderPresentation": "woman", "age": 30}
    they = {"id": "npc:1", "name": "Namea Surnamea", "genderPresentation": "nonbinary", "age": 30}
    for cam, want, n in (
        ("namea stands in the kitchen, chin lifted.", "She stands in the kitchen, chin lifted.", npc),
        ("NAMEA stands in the kitchen, chin lifted.", "She stands in the kitchen, chin lifted.", npc),
        ("In the kitchen, the camera catches Namea by the counter.", "In the kitchen, the camera catches the houseguest by the counter.", npc),
        ("Namea lies back on the sofa, hands folded.", "They lie back on the sofa, hands folded.", they),
        ("Namea focuses on the lens, chin lifted.", "The houseguest focuses on the lens, chin lifted.", they),
        ("Hands loose, and Namea stands by the door.", "Hands loose, and she stands by the door.", npc),
    ):
        prof = {"physicalCharacteristics": {"onCamera": cam}}
        gate.mend(prof, n, [n])
        assert prof["physicalCharacteristics"]["onCamera"] == want, cam
    assert gate.plural_verb("lies") == "lie" and gate.plural_verb("tries") == "try" and gate.plural_verb("focuses") is None


def test_an_everyday_word_given_name_keeps_its_case_rule():
    may = {"id": "npc:1", "name": "May Surnamea", "genderPresentation": "woman", "age": 30}
    prof = {"physicalCharacteristics": {"onCamera": "She may lean on the counter while May stands by the door."}}
    gate.mend(prof, may, [may])
    assert prof["physicalCharacteristics"]["onCamera"] == "She may lean on the counter while she stands by the door."


def test_photohair_openings_already_used_reach_the_next_writers_prompt():
    g = gate.SeasonGate("t")
    npc = {"id": "npc:1", "name": "Namea Surnamea", "genderPresentation": "man", "age": 30}
    prof = {"biography": "Namea welds boats and keeps lists of everything. He sleeps badly on Sundays.", "identityConcept": "Namea welds.",
            "physicalCharacteristics": {"photoHair": "close cropped and neat, edges crisp for the shoot"}}
    g.accept("npc:1", prof, npc, [npc])
    ph = g.taken_phrases("npc:2")
    assert ph["photohair_openings"] == ["close cropped"]
    text = _msg({"vocations": [], "hometowns": [], "phrases": ph})
    assert "photoHair lines already open: close cropped" in text


def test_the_signature_lean_is_a_plain_word_in_the_taken_list_not_part_of_the_opening_pattern():
    assert "lookSignature" not in " ".join(ca.opening_pattern(2))  # the period-6 opening pattern stays as it was
    lean = ca._signature_lean(2)
    assert lean and "-" not in lean  # plain words ("jewellery", "a hat or headwear"), never an internal category name
    assert f"leans toward {lean}" in _msg({"vocations": [], "hometowns": [], "signature_lean": lean})

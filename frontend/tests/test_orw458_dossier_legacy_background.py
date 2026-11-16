"""Review of #2788: a card saved before ORW-458 can carry "who plays as a <archetype>" in its background; the dossier projection never shows it."""
import importlib

R = importlib.import_module("routes.orwell_routes")


def test_a_legacy_generated_archetype_suffix_is_stripped_from_the_dossier_background():
    out = R._public_persona({"background": "a nurse who plays as a villain", "vocation": "nurse"})
    assert out["background"] == "a nurse"
    assert "villain" not in str(out)
    assert R._public_persona({"background": "a welder who plays as an underdog."})["background"] == "a welder"


def test_a_new_background_and_a_non_string_one_are_untouched():
    assert R._public_persona({"background": "a nurse from Macon"})["background"] == "a nurse from Macon"
    assert R._public_persona({"background": "who plays as a villain"})["background"] == "who plays as a villain"  # nothing left to show: keep as is

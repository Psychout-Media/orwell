"""ORW-1056: the casting read-back announces ONE card, from the engine's recorded archetype, and assumes no gender. Roles only."""
import importlib

al = importlib.import_module("src.agent_loop")


def test_the_casting_preamble_asks_for_one_card_from_the_recorded_archetype():
    p = al.CASTING_AGENT_PREAMBLE
    assert "exactly ONCE" in p and "createCharacter result" in p
    assert "second card" in p and "second archetype" in p


def test_the_casting_preamble_forbids_an_assumed_gender():
    p = al.CASTING_AGENT_PREAMBLE
    assert "pronouns they gave" in p and "Never assume a gender" in p


def test_the_finalize_nudges_and_forced_note_carry_the_same_two_rules():
    for text in (al._CASTING_NUDGES[0], al._CASTING_FORCED_NOTE):
        assert "ONCE" in text and "archetype" in text
        assert "pronouns the player gave" in text

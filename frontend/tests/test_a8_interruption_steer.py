"""A8: the NPC-interruption steer. The engine decides who/why (board.interruption); the FE only voices it. Roles only."""
import importlib

importlib.import_module("src.agent_tools")
ch = importlib.import_module("routes.chat_helpers")


def test_each_desire_has_a_voiced_entrance():
    for d in ("campaign", "plea", "probe", "check-in"):
        s = ch._interruption_steer({"interruption": {"npc": "the Role", "desire": d}})
        assert "engine-decided" in s and "the Role steps into" in s and "invent no outcome" in s


def test_absent_or_malformed_interruption_is_silent():
    assert ch._interruption_steer({}) == ""
    assert ch._interruption_steer({"interruption": None}) == ""
    assert ch._interruption_steer({"interruption": {"desire": "plea"}}) == ""
    assert ch._interruption_steer(None) == ""


def test_unknown_desire_falls_back_to_check_in():
    assert "word with the player" in ch._interruption_steer({"interruption": {"npc": "X", "desire": "???"}})


def test_orw261_a_chosen_tell_is_voiced_not_invented():
    s = ch._interruption_steer({"interruption": {"npc": "the Role", "desire": "check-in", "tells": "They tell you, in confidence and in their own words, that they are X."}})
    assert "choose to confide" in s and "that they are X." in s and "Add no outcome" in s
    assert "choose to confide" not in ch._interruption_steer({"interruption": {"npc": "the Role", "desire": "check-in"}})

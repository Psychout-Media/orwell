"""ORW-1182 - a competition is told once (Ryne's live game: the same eliminations re-voiced across advances, catchphrases verbatim up to six times, the player's own fall written for them).
Deterministic cuts on the reply: an exit an earlier reply voiced is not narrated falling again; a sentence repeated from the last five replies (or earlier in this reply) is cut."""
import asyncio
import importlib

cr = importlib.import_module("src.orwell_comp_repeat")
ch = importlib.import_module("routes.chat_helpers")

STATE = {"ceremony": {"competition": {"out": [{"id": "npc:1", "name": "Vanessa Cole"}, {"id": "npc:2", "name": "Stella Park"}, {"id": "npc:3", "name": "Javier Ruiz"}], "stillIn": []}}}
R1 = "Vanessa slips on the second wall and drops out. Javier loses his grip and goes down. Nobody tell me where to stand, Kai says."


def _fresh(user="u1182"):
    cr.reset(user)
    return user


def test_an_exit_voiced_in_an_earlier_reply_is_not_narrated_falling_again():
    u = _fresh()
    cr.record_turn(u, R1, STATE)
    kept, dropped = cr.screen(u, "Vanessa wobbles and falls out of the round again. Kai laughs at the wall. Tara looks down at her feet.")
    assert "Vanessa" not in kept and "Kai laughs" in kept and "Tara looks down" in kept
    assert [r for r, _ in dropped] == ["told-exit"]


def test_a_verbatim_sentence_from_the_last_five_replies_is_cut_and_the_rest_stays():
    u = _fresh()
    cr.record_turn(u, R1, STATE)
    kept, dropped = cr.screen(u, "Nobody tell me where to stand, Kai says. Jace reaches for the rope.")
    assert "Nobody tell me" not in kept and "Jace reaches for the rope." in kept
    assert [r for r, _ in dropped] == ["verbatim"]


def test_the_repeat_window_is_five_replies():
    u = _fresh()
    cr.record_turn(u, "Tara hums a tune to the wall of mud before the round.", STATE)
    for i in range(5):
        cr.record_turn(u, f"Round {i} brings a brand new sentence about the course today.", STATE)
    kept, dropped = cr.screen(u, "Tara hums a tune to the wall of mud before the round.")
    assert dropped == [] and "hums a tune" in kept, "the sixth reply back is outside the window"


def test_a_repeat_inside_one_reply_is_cut_across_chunks():
    u = _fresh()
    cr.record_turn(u, "The course opens at dawn with a long horn.", STATE)
    a, _ = cr.screen(u, "Kai says I've got a room to myself, grinning at the camera. ")
    b, dropped = cr.screen(u, "Kai says I've got a room to myself, grinning at the camera. Ana ties her shoes.")
    assert "room to myself" in a and "room to myself" not in b and "Ana ties her shoes." in b and dropped


def test_nothing_is_cut_without_an_earlier_reply_of_a_live_competition():
    u = _fresh()
    t = "Vanessa drops out of the first round. Vanessa drops out of the first round."
    assert cr.screen(u, t) == (t, [])


def test_the_ledger_is_forgotten_when_the_competition_is_over():
    u = _fresh()
    cr.record_turn(u, R1, STATE)
    cr.record_turn(u, "Kai wins Head of Household and the house erupts around him.", {"ceremony": {}})
    t = "Vanessa falls and is out of the game for good."
    assert cr.screen(u, t) == (t, [])


def test_short_stock_lines_and_non_fall_mentions_are_kept():
    u = _fresh()
    cr.record_turn(u, "Okay. " + R1, STATE)
    kept, dropped = cr.screen(u, "Okay. Vanessa claps for the next climber from the sidelines.")
    assert dropped == [] and kept.startswith("Okay.")


def test_the_competition_steer_says_the_player_is_reported_never_acted_out():
    t = ch._competition_scene_steer([("comp-elimination", "Houseguest One is out; 3 remain")])
    low = t.lower()
    assert "never write the player's own fall" in low and "earlier replies" in low

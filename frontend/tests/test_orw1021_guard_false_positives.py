"""ORW-1021 - false positives found in the dev journals (fires on closed-set guards that the narrator's text did not earn). Pure functions, no engine, no model calls.
Red on the old code, plus a negative control per fix that the real claim is still caught."""
import importlib

ch = importlib.import_module("routes.chat_helpers")


# --- "<Name> takes it" read as a competition result -------------------------------------------------
def test_takes_it_with_a_manner_phrase_is_not_a_competition_result():
    for t in ("Layla takes it standing, and her chin doesn't come down.",
              "Nolan Ceja takes it without a flicker, he stands with his hands in his pockets.",
              "Emilio takes it and doesn't dress it up.",
              "Kristin takes it in without a flicker of performance."):
        assert not ch._comp_decisive_hit(t), t


def test_takes_it_ending_the_clause_and_wins_it_stay_results():
    assert ch._comp_decisive_hit("Tara takes it.")
    assert ch._comp_decisive_hit("Ellis wins it. They come down off the wall.")
    assert ch._comp_decisive_hit("Tara takes the competition.")


# --- the stakes line "Win it and you're Head of Household" ------------------------------------------
def test_stakes_line_is_not_a_self_crown():
    t = "Win it and you're Head of Household: untouchable for the week, and you name the two people who go up."
    assert not ch._committed_claim(ch._CLAIM_SELF_HOH_WIN_RE, t, ch._CLAIM_RULE_CUE_RE, ch._self_crown_is_vocative, {"hohName": "Sam"})
    assert ch._committed_claim(ch._CLAIM_SELF_HOH_WIN_RE, "You're the Head of Household.", ch._CLAIM_RULE_CUE_RE, ch._self_crown_is_vocative, {"hohName": "Sam"})


# --- a houseguest's "not gonna nominate" -----------------------------------------------------------
def test_future_intent_to_nominate_is_not_a_nomination():
    t = "Cora's not gonna nominate somebody she's got a thing with, so the math says it's not me."
    assert ch._nomination_claims_all_hypothetical(t)
    assert not ch._nomination_claims_all_hypothetical("The HOH nominates two houseguests.")


# --- an interrogative about the veto -----------------------------------------------------------------
def test_who_is_holding_the_veto_question_is_not_a_phantom_holder():
    live = {"phase": "veto-competition", "vetoHolder": None, "vetoUsed": False}
    assert ch._veto_possession_without_holder("The interesting question is who's holding the veto when it's over.\" He looks at you.", live) is None
    assert ch._veto_possession_without_holder("He turns the veto over in his hand.", live)


# --- headcount: "the other one", "N people left [the room]", "all sixteen of us" -------------------------
def test_the_other_one_is_not_a_headcount():
    assert not [c for c in ch._engine_count_claims("She looks at one of them, then at the other one.") if c.kind == "others"]
    assert [c for c in ch._engine_count_claims("The other three are here.") if c.kind == "others"]


def test_people_left_the_room_is_not_a_house_count():
    for t in ("Two of us left the kitchen after that.", "Four people left through the back door.", "Two people left early."):
        assert not [c for c in ch._engine_count_claims(t) if c.kind.startswith("house")], t
    assert [c for c in ch._engine_count_claims("Eleven of us left.") if c.kind == "house"]
    assert [c for c in ch._engine_count_claims("Eleven of us left in the game.") if c.kind == "house"]
    assert [c for c in ch._engine_count_claims("Eleven houseguests remain.") if c.kind == "house-loose"]


def test_unanchored_all_of_us_may_mean_the_whole_house():
    c = {"room": 13, "others": 12, "house": 16}
    claim = ch._EcClaim("room", 16, "all sixteen of us")
    assert ch._engine_count_ok(claim, c)
    anchored = ch._EcClaim("room", 16, "the sixteen of us in here")
    assert not ch._engine_count_ok(anchored, c)
    wrong = ch._EcClaim("room", 9, "the nine of us")
    assert not ch._engine_count_ok(wrong, c)

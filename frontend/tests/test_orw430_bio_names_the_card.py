"""ORW-430: a houseguest's story must be about the card's own name.

Live case (2026-11-15): Samir Nesbitt's biography opened "Nia grew up ...". Genesis wrote the name with the identity and
first biography; a later gender-coherence re-pick changed the given name and left the prose. Every probe is the live
card text; no model call is made.
"""
import json
import os

import pytest

from src import orwell_cast_authoring as ca
from src import orwell_cast_genesis as G

CARDS = json.load(open(os.path.join(os.path.dirname(__file__), "fixtures", "orw430_live_cards.json")))


def npc_of(name, cast_extra=()):
    c = CARDS[name]
    return {"id": c["id"], "name": name, "age": c["age"], "genderPresentation": c["genderPresentation"],
            "vocation": c["vocation"], "identityConcept": c["identityConcept"], "hometown": "Converse, Texas"}


def cast15(npc, wrong_idx=None):
    firsts = ["Ava", "Bo", "Cal", "Dee", "Eli", "Fay", "Gus", "Hal", "Ivy", "Jon", "Kai", "Lou", "Max", "Ned", "Oli"]
    return [{"id": f"npc:{i}", "name": f"{f} Surname{i}"} for i, f in enumerate(firsts)] + [npc]


# ---- the cause at the writers: what each step is given and told ----------------------------------------
def test_genesis_prompt_writes_identity_and_biography_without_the_houseguests_name():
    s = G._SYSTEM
    bio = s[s.index('"biography": a 2-3 sentence'):][:420]
    assert "NO given name" in bio and "use the role, never a first name" in bio
    assert "NO first name for them" in s and "the name can change when the gender is pinned" in s


def test_authoring_writer_is_given_the_final_name_and_told_to_write_about_that_person():
    msgs = ca.build_authoring_messages(npc_of("Samir Nesbitt"))
    user = msgs[1]["content"]
    assert '"name": "Samir Nesbitt"' in user
    assert "The biography is about Samir Nesbitt and no one else" in user and "never give them any other first name" in user


# ---- the net -------------------------------------------------------------------------------------------
def test_samir_nia_biography_is_caught_and_repaired_to_samir_with_the_right_pronouns():
    npc = npc_of("Samir Nesbitt")
    prof = {"biography": CARDS["Samir Nesbitt"]["biography"]}
    assert "story-name" in ca.story_problems(prof, npc)
    fixed = ca.repair_story_text(prof["biography"], prof, npc)
    assert "Nia" not in fixed and fixed.startswith("Samir grew up") and "Off the clock Samir sings" in fixed
    assert ca.story_problems({"biography": fixed}, npc) == []


def test_name_repair_runs_before_the_pronoun_check_so_nia_she_becomes_samir_he():
    npc = npc_of("Samir Nesbitt")
    text = "Nia grew up in Converse. Off the clock Nia sings alto and she keeps her patience. Nia hums while she works."
    # before the name is repaired the sentences are skipped as being about "another capitalised person"
    assert 1 not in ca.pronoun_conflict_sentences(text, npc)
    fixed = ca.repair_story_text(text, {}, npc)
    assert fixed == "Samir grew up in Converse. Off the clock Samir sings alto and he keeps his patience. Samir hums while he works."


def test_thomas_sizemore_control_is_unchanged():
    npc = npc_of("Thomas Sizemore")
    bio = CARDS["Thomas Sizemore"]["biography"]
    assert ca.story_problems({"biography": bio}, npc) == []
    assert ca.repair_story_text(bio, {"biography": bio}, npc) == bio


def test_a_person_named_in_passing_is_left_alone():
    npc = npc_of("Samir Nesbitt")
    for bio in ("Samir learned the trade under Chief Alvarez. His sister Nia still sings in the choir. Nia taught him alto.",
                "Samir grew up near Converse. Converse raised him on casseroles and quiet."):
        assert ca.story_problems({"biography": bio}, npc) == []
        assert ca.repair_story_text(bio, {"biography": bio}, npc) == bio


def test_another_cast_members_name_as_subject_is_its_own_code_and_repaired_the_same_way():
    npc = npc_of("Samir Nesbitt")
    cast = cast15(npc)
    bio = "Ava grew up in Converse helping at the funeral home. Ava sings alto in a choir."
    assert ca.story_problems({"biography": bio}, npc, cast) == ["story-cast-name"]
    assert ca.repair_story_text(bio, {}, npc).startswith("Samir grew up")
    # the same name in passing is left alone
    assert ca.story_problems({"biography": "Samir sings alto. Ava sings tenor beside him."}, npc, cast) == []


def test_a_nickname_of_the_own_first_name_is_not_claimed():
    npc = {"id": "npc:9", "name": "Samuel Nesbitt", "genderPresentation": "man", "age": 23}
    bio = "Sam grew up helping at the funeral home. Sam sings alto."
    assert ca.story_problems({"biography": bio}, npc) == []


def test_a_fifteen_card_cast_with_one_wrong_name_repairs_exactly_one_card():
    wrong = npc_of("Samir Nesbitt")
    cast = cast15(wrong)
    wrong_bio = CARDS["Samir Nesbitt"]["biography"]
    changed = 0
    for i, c in enumerate(cast):
        first = c["name"].split()[0]
        bio = wrong_bio if c is wrong else f"{first} grew up in Waco, Texas, and teaches shop class. {first} coaches the debate team on weekends."
        card = {**c, "genderPresentation": "man", "age": 30}
        prof = {"biography": bio}
        if ca.repair_story_text(bio, prof, card) != bio:
            changed += 1
    assert changed == 1


# ---- identityConcept: the two live pronoun lines -------------------------------------------------------
@pytest.mark.parametrize("name,needle,gone", [("Gabe Cottrell", "he's running the house", "she's"),
                                              ("Imani Mason", "her own brilliance", " his ")])
def test_live_identity_lines_are_repaired_to_the_pinned_gender(name, needle, gone):
    npc = npc_of(name)
    fixed = ca.repair_story_text(CARDS[name]["identityConcept"], {}, npc)
    assert needle in fixed and gone not in fixed
    assert "her chessboard" in fixed or name != "Imani Mason"


def test_repair_story_reaches_the_identity_concept_through_the_card():
    npc = npc_of("Gabe Cottrell")
    prof = {"biography": CARDS["Gabe Cottrell"]["biography"]}
    assert "identityConcept" in ca.repair_story(prof, npc)
    assert "he's running the house" in prof["identityConcept"]


# ---- ORW-430 part 2: a card with no biography is never "authored" -------------------------------------
from conftest import _run  # noqa: E402

BRIANA = json.load(open(os.path.join(os.path.dirname(__file__), "fixtures", "orw430_briana_no_bio.json")))
_PC = {"heightBuild": "short", "skinTone": "tan", "hair": "dark waves", "facialFeatures": "a wide smile",
       "distinguishingMark": "none notable", "ageLook": "early twenties", "style": "plain"}
_BRIANA_NPC = {**BRIANA, "id": "npc:15"}
_GOOD_BIO = "Briana raised her younger siblings in Macon and now works as a home-health aide. She feeds everyone who walks in."


def test_cause_briana_is_marked_authored_but_has_no_biography_and_the_roster_never_re_picked_her():
    assert BRIANA["authored"] is True and not BRIANA.get("biography")
    assert ca.card_missing_story(BRIANA) is True
    assert ca.unauthored_ids("u", [BRIANA]) == ["npc:15"]  # now taken again by the existing backfill
    assert ca.unauthored_ids("u", [{**BRIANA, "biography": _GOOD_BIO}]) == []


def test_biography_floor_boundary():
    ok = "A" * 39 + ". " + "B" * 38 + "."  # 80 chars, 2 sentences
    assert len(ok) == 80 and ca._biography_meets_floor(ok)
    assert not ca._biography_meets_floor(ok[:-1])
    assert not ca._biography_meets_floor("C" * 90 + ".")  # one sentence


def _drive430(replies):
    sent, writes = [], []

    async def llm_fn(messages):
        sent.append(messages)
        return replies[min(len(sent), len(replies)) - 1]

    async def write_fn(p):
        writes.append(p)
        return {"accepted": True}

    n = _run(ca.author_cast([dict(_BRIANA_NPC)], llm_fn, write_fn))
    return n, sent, writes


def _reply430(bio):
    d = {"vocation": "home-health aide", "physicalCharacteristics": _PC}
    if bio is not None:
        d["biography"] = bio
    return json.dumps(d)


def test_missing_biography_gets_one_strict_retry_naming_the_field_and_the_fixed_card_is_written():
    n, sent, writes = _drive430([_reply430(None), _reply430(_GOOD_BIO)])
    assert n == 1 and len(sent) == 2 and writes[0]["biography"] == _GOOD_BIO
    assert "biography is missing or too short" in sent[1][-1]["content"]


def test_still_missing_after_the_retry_the_card_is_not_written_and_not_authored():
    n, sent, writes = _drive430([_reply430(None), _reply430("Too short.")])
    assert n == 0 and writes == [] and len(sent) == 2  # exactly one retry: the cap


def test_final_check_names_codes_only_and_is_clean_on_a_good_card():
    good = {"biography": _GOOD_BIO, "identityConcept": BRIANA["identityConcept"]}
    assert ca.card_consistency(good, _BRIANA_NPC) == []
    codes = ca.card_consistency({"biography": ""}, {**_BRIANA_NPC, "identityConcept": ""})
    assert codes == ["story-no-biography", "identity-missing"]


# ---- ORW-430b: required look fields, nonbinary identity, the final check's shape ----------------------
MONIQUE = {"id": "npc:2", "name": "Monique Tarver", "age": 25, "genderPresentation": "nonbinary",
           "vocation": "insurance claims analyst"}
MONIQUE_ID = ("A relentlessly effusive claims analyst who narrates every social interaction as a probability table and is "
              "genuinely shocked, every single time, that people are more complicated than the spreadsheet in her head.")


def test_monique_nonbinary_identity_says_their_head_not_her_head():
    assert ca.pronoun_conflict_sentences(MONIQUE_ID, MONIQUE) == [0]
    assert ca.repair_story_text(MONIQUE_ID, {}, MONIQUE).endswith("the spreadsheet in their head.")


def test_giovanni_authored_without_wardrobe_oncamera_photohair_is_listed_again_and_reported():
    pc = {"heightBuild": "lean", "skinTone": "tan", "hair": "short", "facialFeatures": "x", "distinguishingMark": "none",
          "ageLook": "early twenties", "style": "plain"}
    card = {"id": "npc:7", "status": "active", "authored": True, "biography": _GOOD_BIO, "identityConcept": "A restless lab tech.",
            "physicalCharacteristics": pc}
    assert ca.unauthored_ids("u", [card]) == []  # ORW-431: a missing look sub-field never holds the season start (readiness)
    assert ca.unauthored_ids("u", [card], include_look=True) == ["npc:7"]  # ... it asks the backfill
    codes = ca.card_consistency({"biography": _GOOD_BIO}, {"id": "npc:7", "name": "Briana Calloway", "identityConcept": "A restless lab tech who hums.", "physicalCharacteristics": pc})
    assert codes == ["look-missing-wardrobe", "look-missing-onCamera", "look-missing-photoHair"]
    full = {**pc, "wardrobe": ["a", "b"], "onCamera": "kitchen", "photoHair": "short"}
    assert ca.unauthored_ids("u", [{**card, "physicalCharacteristics": full}]) == []


def test_final_check_returns_a_flat_list_of_reason_code_strings():
    codes = ca.card_consistency({"biography": ""}, {"id": "npc:1", "name": "Sam Lee", "genderPresentation": "man"})
    assert isinstance(codes, list) and all(isinstance(c, str) for c in codes)

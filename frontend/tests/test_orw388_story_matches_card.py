"""ORW-388: a houseguest's own story must match their card (pronouns, age, look, the show's name).

Every probe is the live-season text from 2026-11-14 or a role-only variant. No model call is made: the prompts are
read as text and the writer is a scripted function.
"""
import json
import os
import re

from conftest import _run

from src import orwell_cast_authoring as ca
from src import orwell_cast_genesis as G

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

LIAM = {"id": "npc:1", "name": "Liam Colvin", "genderPresentation": "man", "age": 30, "hometown": "Waco, Texas",
        "vocation": "sommelier"}
LIAM_ID = ("Liam floats through the Big Brother house like she's tasting every dish, convinced she's the mastermind "
           "of her own destiny.")
DELPHINE = {"id": "npc:2", "name": "Delphine Prewitt", "genderPresentation": "woman", "age": 25}
SALMA = {"id": "npc:3", "name": "Salma Post", "genderPresentation": "woman", "age": 49}
LAURA = {"id": "npc:4", "name": "Laura Ware", "genderPresentation": "woman", "age": 34,
         "physicalCharacteristics": {"heightBuild": "tall and broad-shouldered, willowy limbs", "skinTone": "fair",
                                     "hair": "brown", "facialFeatures": "a square jaw",
                                     "distinguishingMark": "none notable", "ageLook": "mid thirties", "style": "plain"}}
SAM = {"id": "npc:5", "name": "Sam Lee", "genderPresentation": "nonbinary", "age": 28}


# ---- the cause, at the source: what each writer is given and told -------------------------------------
def test_neither_writer_prompt_calls_the_show_big_brother():
    for text in (ca._SYSTEM, G._SYSTEM):
        assert "Big Brother" not in text.replace("never call it Big Brother", "").replace("never Big Brother", "")
        assert "ORWELL" in text


def test_genesis_identity_is_pronoun_free_ageless_and_featureless():
    """Cause of the wrong pronoun, wrong age and invented feature in identityConcept: genesis wrote the identity before
    gender, exact age and look were final and never told the writer so. It now writes none of the three."""
    s = G._SYSTEM
    ident = s[s.index("ONE vivid sentence"):][:700]
    for needle in ("NO pronouns", "NO number of years", "NO face or body features", "never Big Brother"):
        assert needle in ident
    assert "fixed in LATER steps" in s and "chosen pronouns" not in s


def test_authoring_prompt_gives_age_gender_pronouns_and_look_beside_the_biography():
    msgs = ca.build_authoring_messages({**LIAM, "physicalCharacteristics": LAURA["physicalCharacteristics"]})
    user, system = msgs[1]["content"], msgs[0]["content"]
    assert '"age": 30' in user and '"genderPresentation": "man"' in user and "physicalCharacteristics" in user
    assert "PINNED gender presentation is 'man'" in user and "named by role" in user
    for needle in ("STORY MATCHES THE CARD", "ONLY the houseguest's pinned pronouns", "skeleton's exact age",
                   "does not carry", "never Big Brother"):
        assert needle in system


def test_marks_list_no_longer_offers_scars_birthmarks_or_tooth_gaps():
    mark = ca._SYSTEM[ca._SYSTEM.index("A distinguishingMark is usually"):][:330]
    assert "gap-toothed grin" not in mark and "a scar, a birthmark" not in mark
    assert "no scars, birthmarks or tooth gaps" in mark


# ---- the net: each rejection and each repair, with the four live examples ------------------------------
def test_pronoun_repair_liam_man_with_she():
    assert ca.pronoun_conflict_sentences(LIAM_ID, LIAM) == [0]
    out = ca.repair_story_text(LIAM_ID, {}, LIAM)
    assert out == ("Liam floats through the Orwell house like he's tasting every dish, convinced he's the mastermind "
                   "of his own destiny.")


def test_pronoun_repair_woman_and_nonbinary():
    assert ca.repair_story_text("Delphine bakes and he sings to his dough.", {}, DELPHINE) == \
        "Delphine bakes and she sings to her dough."
    assert ca.repair_story_text("Sam says she hosts and he passes.", {}, SAM) == "Sam says they host and they pass."
    assert ca.repair_story_text("She's sure of it.", {}, SAM) == "They're sure of it."


def test_a_pronoun_that_refers_to_someone_else_is_never_flagged_or_rewritten():
    """How it is decided: a wrong-gender pronoun counts only in a sentence that names no one else (no relative, rival or
    colleague by role, no other capitalised name). A false repair is worse than a miss."""
    assert ca.repair_story_text("Her mother raised him alone.", {}, LIAM) == "Her mother raised him alone."
    assert ca.repair_story_text("His sister runs the bakery.", {}, DELPHINE) == "His sister runs the bakery."
    assert ca.repair_story_text("Delphine bakes while his friend Marcus watches.", {}, DELPHINE) == \
        "Delphine bakes while his friend Marcus watches."
    assert ca.story_problems({"biography": "Her brother is a pilot. He was born in Waco."}, LIAM) == []


def test_age_delphine_24_vs_25_and_salma_52_vs_49():
    assert ca.repair_story_text("A 24-year-old HR onboarding coordinator.", {}, DELPHINE) == \
        "A 25-year-old HR onboarding coordinator."
    assert ca.repair_story_text("A 52-year-old retired Army combat medic.", {}, SALMA) == \
        "A 49-year-old retired Army combat medic."
    assert ca.story_age_conflict("A 52-year-old medic.", SALMA)
    assert not ca.story_age_conflict("A 49-year-old medic.", SALMA)


def test_age_ignores_other_peoples_ages_and_past_life_events():
    assert not ca.story_age_conflict("Her 52-year-old mother lives nearby.", DELPHINE)
    assert not ca.story_age_conflict("A 12-year-old niece adores her.", DELPHINE)
    assert not ca.story_age_conflict("At 19 she joined the Army.", SALMA)
    assert ca.story_age_conflict("At 47 she is the oldest in the house.", SALMA)
    assert ca.repair_story_text("At 47 she is the oldest in the house.", {}, SALMA) == "At 49 she is the oldest in the house."


def test_feature_laura_gap_toothed_with_no_tooth_gap_in_the_look():
    bio = "Laura is a gap-toothed forklift driver who loves a quiet morning."
    assert ca.story_missing_features(bio, {}, LAURA) == ["tooth-gap"]
    assert ca.story_problems({"biography": bio}, LAURA) == ["story-feature"]
    assert ca.repair_story_text(bio, {}, LAURA) == "Laura is a forklift driver who loves a quiet morning."


def test_feature_kept_when_the_look_has_it():
    npc = {**LAURA, "physicalCharacteristics": {**LAURA["physicalCharacteristics"], "facialFeatures": "a tooth gap and a square jaw"}}
    assert ca.story_missing_features("Gap-toothed Laura laughs.", {}, npc) == []


def test_feature_tattoo_and_glasses_dropped_and_wine_glasses_kept():
    out = ca.repair_story_text("Laura grins with a tattoo on her arm and bakes at dawn.", {}, LAURA)
    assert "tattoo" not in out and "bakes at dawn" in out
    assert "glasses" not in ca.repair_story_text("Laura pushes up her round glasses and bakes.", {}, LAURA)
    keep = "Laura raised her wine glasses to the room."
    assert ca.story_missing_features(keep, {}, LAURA) == []


def test_big_brother_becomes_orwell():
    assert ca.story_problems({"biography": "Laura loves the Big Brother house."}, LAURA) == ["story-show-name"]
    assert ca.repair_story_text("Laura loves the Big Brother house.", {}, LAURA) == "Laura loves the Orwell house."
    assert ca.repair_story_text("A Big Brother superfan.", {}, LAURA) == "A Orwell superfan."  # grammar is not touched


def test_clean_story_is_byte_identical():
    bio = "Laura drives a forklift in Tulsa and never misses a sunrise. Her mother taught her to bake."
    assert ca.repair_story_text(bio, {}, LAURA) == bio and ca.story_problems({"biography": bio}, LAURA) == []


def test_laura_build_contradiction_is_caught_by_the_existing_look_check():
    """heightBuild 'tall and broad-shouldered, willowy limbs': ORW-360's build-contradiction already rejects it."""
    assert ca.look_problems({"physicalCharacteristics": LAURA["physicalCharacteristics"]}, LAURA) == ["build-contradiction"]


def test_retry_message_names_each_story_code_without_the_text():
    msg = ca.look_retry_message(["story-pronoun", "story-age", "story-feature", "story-show-name"])
    for code in ("story-pronoun", "story-age", "story-feature", "story-show-name"):
        assert code in msg
    assert "Colvin" not in msg


# ---- end to end through author_cast: one strict retry, then the deterministic repair -------------------
_PC = {"heightBuild": "tall and lean", "skinTone": "tan", "hair": "short brown hair", "facialFeatures": "a square jaw",
       "distinguishingMark": "none notable", "ageLook": "thirties", "style": "plain"}
_NPC = {**LIAM, "physicalCharacteristics": _PC, "identityConcept": LIAM_ID}


def _reply(bio):
    return json.dumps({"biography": bio, "vocation": "sommelier", "physicalCharacteristics": _PC})


def _drive(replies):
    sent, writes = [], []

    async def llm_fn(messages):
        sent.append(messages)
        return replies[min(len(sent), len(replies)) - 1]

    async def write_fn(p):
        writes.append(p)
        return {"accepted": True}

    assert _run(ca.author_cast([dict(_NPC)], llm_fn, write_fn)) == 1
    return sent, writes


GOOD = "Liam pours wine in Waco and he never misses a sunrise. Friends call him loyal, and his cellar is famous."
BAD = "Liam is a 24-year-old sommelier at the Big Brother lounge. He is gap-toothed and wears round glasses. She loves wine."


def test_retry_fixes_the_biography_and_the_identity_concept_is_repaired_in_the_write():
    sent, writes = _drive([_reply(BAD), _reply(GOOD)])
    assert len(sent) == 2
    retry = sent[1][-1]["content"]
    for code in ("story-pronoun", "story-age", "story-feature", "story-show-name"):
        assert code in retry
    assert writes[0]["biography"] == GOOD
    assert writes[0]["identityConcept"].startswith("Liam floats through the Orwell house like he's tasting")


def test_failed_retry_repairs_the_biography_deterministically():
    sent, writes = _drive([_reply(BAD)])
    assert len(sent) == 2
    bio = writes[0]["biography"]
    assert "Big Brother" not in bio and "24-year-old" not in bio and "30-year-old" in bio
    assert "gap-toothed" not in bio and "glasses" not in bio and "She loves" not in bio and "He loves wine" in bio


def test_clean_story_makes_no_retry_and_leaves_no_identity_key():
    npc = {**_NPC, "identityConcept": "Liam is a steady, funny host who keeps the peace."}
    sent, writes = [], []

    async def llm_fn(messages):
        sent.append(messages)
        return _reply(GOOD)

    async def write_fn(p):
        writes.append(p)
        return {"accepted": True}

    assert _run(ca.author_cast([npc], llm_fn, write_fn)) == 1
    assert len(sent) == 1 and "identityConcept" not in writes[0]


# ---- the source lists ---------------------------------------------------------------------------------
def _ts_list(name):
    src = open(os.path.join(REPO, "src", "engine", "genesisConstants.ts"), encoding="utf-8").read()
    body = re.search(r"export const %s[^=]*= \[(.*?)\];" % name, src, re.S).group(1)
    return [json.loads(m) for m in re.findall(r'("(?:[^"\\]|\\.)*")', body)]


def test_genesis_look_features_have_no_scar_birthmark_chipped_or_tooth_gap_and_match_ts():
    py = list(G.GENESIS_LOOK_FEATURES)
    assert py == _ts_list("GENESIS_LOOK_FEATURES")
    for f in py:
        assert not re.search(r"scar|birthmark|chipped|gap-?tooth", f, re.I), f

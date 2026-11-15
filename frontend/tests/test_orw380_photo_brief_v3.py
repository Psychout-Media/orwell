"""ORW-380: photo brief v3. The shared photo-sheet instruction and checker, the writer input, the gray-hair
fallback hole, and the new-cast de-duplication post-pass."""
import asyncio
import json

import pytest

from src import orwell_cast_authoring as ca
from conftest import _run


def _npc(gender="woman", age=30, **kw):
    n = {"id": "npc:1", "name": "Rosa Vega", "age": age, "genderPresentation": gender, "presentation": "soft tailoring",
         "physicalCharacteristics": {"hair": "long dark waves", "heightBuild": "tall and lean", "style": "x"}}
    n.update(kw)
    return n


def _pc(**kw):
    return {"physicalCharacteristics": kw}


GOOD_ON = "She stands in the kitchen, arms folded, eyes on the camera, a small smile, the one who misses nothing."


def test_a_clean_sheet_passes():
    p = _pc(wardrobe=["a camel wool coat", "dark trousers"], photoHair="sleek neat braid over one shoulder", onCamera=GOOD_ON)
    assert ca.look_problems(p, _npc()) == []
    assert ca.look_problems(p, _npc(), {"mainPieces": ["a leather jacket"], "spots": {"kitchen": 2}}) == []


@pytest.mark.parametrize("line", [
    "She laughs, then walks into the kitchen.",
    "She says hello at the kitchen counter.",
    "She narrates the day from the kitchen.",
    "She tells a joke in the kitchen.",
    "She is cooking in the kitchen, the one who misses nothing.",
    "She waits for everyone in the kitchen.",
    "She stands in the kitchen with someone nearby.",
    "She paces the kitchen.",
    "She is mid-sentence in the kitchen.",
    "She is humming in the kitchen.",
    "She is scrubbing the kitchen counter.",
    "She stands in the kitchen and the backyard, arms folded.",
    "She stands in the kitchen. " + "x" * 260,
])
def test_scene_like_oncamera_is_rejected(line):
    assert "oncamera-scene" in ca.look_problems(_pc(onCamera=line), _npc())


def test_the_closing_read_may_say_someone_who():
    ok = "She stands in the kitchen, arms folded, eyes on the camera, someone who misses nothing."
    assert ca.look_problems(_pc(onCamera=ok), _npc()) == []
    assert "oncamera-scene" in ca.look_problems(_pc(onCamera="Someone walks past her in the kitchen, someone who misses nothing."), _npc())


def test_scene_oncamera_retries_once_then_is_omitted_and_wardrobe_stays():
    n = _npc()
    p = _pc(wardrobe=["a camel wool coat", "dark trousers"], onCamera="She says hi then leaves the kitchen.")
    probs = ca.look_problems(p, n)
    assert probs == ["oncamera-scene"]
    assert "oncamera-scene" in ca.look_retry_message(probs) and "then" in ca.look_retry_message(probs)
    ca.apply_look_fallbacks(p, n, probs)
    assert "onCamera" not in p["physicalCharacteristics"] and p["physicalCharacteristics"]["wardrobe"]


@pytest.mark.parametrize("gender,line,bad", [
    ("man", "She stands in the kitchen, arms folded.", True),
    ("man", "He stands in the kitchen, arms folded.", False),
    ("woman", "He stands in the kitchen, arms folded.", True),
    ("woman", "His arms are folded in the kitchen.", True),
    ("woman", "She stands in the kitchen, arms folded.", False),
    ("nonbinary", "She stands in the kitchen, arms folded.", True),
    ("nonbinary", "He stands in the kitchen, arms folded.", True),
    ("nonbinary", "They stand in the kitchen, arms folded.", False),
])
def test_pronoun_mismatch(gender, line, bad):
    assert ("pronoun-mismatch" in ca.look_problems(_pc(onCamera=line), _npc(gender))) is bad


def test_pronoun_mismatch_omits_only_the_offending_field():
    n = _npc("man")
    p = _pc(wardrobe=["a grey suit jacket", "his dark tie"], onCamera="She stands in the lounge, arms folded.")
    probs = ca.look_problems(p, n)
    assert probs == ["pronoun-mismatch"]
    ca.apply_look_fallbacks(p, n, probs)
    pc = p["physicalCharacteristics"]
    assert "onCamera" not in pc and pc["wardrobe"] == ["a grey suit jacket", "his dark tie"]


@pytest.mark.parametrize("hair", ["a braid that frays by afternoon", "messy bun", "frizzy curls", "flyaway strands",
                                  "ragged ends", "unruly waves", "fuzzy at the edges", "usually shoved back", "x" * 91])
def test_messy_photohair_is_rejected_and_omitted(hair):
    n = _npc()
    p = _pc(photoHair=hair)
    probs = ca.look_problems(p, n)
    assert probs == ["photohair-messy"]
    ca.apply_look_fallbacks(p, n, probs)
    assert "photoHair" not in p["physicalCharacteristics"]


def test_neat_photohair_passes():
    for h in ("sleek neat braid over one shoulder", "glossy waves swept into a high ponytail", "buzzed close with a clean line-up"):
        assert ca.look_problems(_pc(photoHair=h), _npc()) == []


@pytest.mark.parametrize("piece", ["a leather jacket", "a worn leather jacket with brass buttons", "black Leather Jacket"])
def test_wardrobe_taken_compares_the_last_two_words(piece):
    taken = {"mainPieces": ["a tan leather jacket", "a flannel shirt"], "spots": {}}
    assert ca.look_problems(_pc(wardrobe=[piece, "dark jeans"]), _npc(), taken) == ["wardrobe-taken"]
    assert ca.look_problems(_pc(wardrobe=["a grey flannel shirt", "x"]), _npc(), taken) == ["wardrobe-taken"]
    assert ca.look_problems(_pc(wardrobe=["a denim jacket", "x"]), _npc(), taken) == []
    assert ca.look_problems(_pc(wardrobe=["jeans", "a leather jacket"]), _npc(), taken) == []  # only the MAIN piece counts
    assert ca.look_problems(_pc(wardrobe=[piece, "dark jeans"]), _npc()) == []                  # no taken list, no check


def test_wardrobe_taken_keeps_the_clothes_and_names_the_taken_list_in_the_retry():
    n = _npc()
    taken = {"mainPieces": ["a leather jacket"], "spots": {"kitchen": 3}}
    p = _pc(wardrobe=["a leather jacket", "dark jeans"])
    probs = ca.look_problems(p, n, taken)
    assert "leather jacket" in ca.look_retry_message(probs, taken)
    ca.apply_look_fallbacks(p, n, probs)
    assert p["physicalCharacteristics"]["wardrobe"] == ["a leather jacket", "dark jeans"]


def test_gray_hair_young_never_falls_back_to_a_gray_seeded_hair():
    n = _npc(age=24)
    n["physicalCharacteristics"]["hair"] = "silver-streaked undercut"   # the seeded brief itself reads gray
    p = _pc(hair="salt-and-pepper curls")
    probs = ca.look_problems(p, n)
    assert "gray-hair-young" in probs
    ca.apply_look_fallbacks(p, n, probs)
    assert not ca._GRAY_HAIR_RE.search(p["physicalCharacteristics"]["hair"])
    assert "undercut" in p["physicalCharacteristics"]["hair"] and ca.look_problems(p, n) == []


def test_the_shared_instruction_names_the_rules_and_has_no_worked_example():
    t = ca.PHOTO_SHEET_SYSTEM
    for needle in ("wardrobe", "photoHair", "onCamera", "genderPresentation", "taken.mainPieces", "taken.spots",
                   "90 characters", "240 characters", "3-8 words", "ONE spot", "castingType", "without naming the type", "he/him", "she/her", "they/them"):
        assert needle in t
    for banned in ca._ONCAMERA_BANNED_WORDS:
        assert banned in t
    assert "Example:" not in ca._SYSTEM and "mid-joke, a smirk" not in ca._SYSTEM
    assert ca.PHOTO_SHEET_RULES in ca._SYSTEM            # ONE shared text for both writers
    assert "photoHair" in ca._SYSTEM
    assert not any(w in t.lower() for w in ("rough", "unretouched", "flyaway strands", "behind-the-scenes"))


def test_writer_input_carries_name_gender_and_taken_and_no_vault_field():
    card = {"id": "npc:9", "name": "Dev Rao", "genderPresentation": "man", "age": 33, "ethnicity": "Indian American",
            "vocation": "chef", "hometown": "Tulsa", "demeanor": "dry", "archetype": "Planner",
            "identityConcept": "a calm line cook", "presentation": "soft tailoring",
            "castingType": {"label": "the charmer", "read": "easy smile, relaxed confidence", "secretNote": "VAULT"},
            "voice": {"energy": "low", "register": "dry", "catchphrases": ["VAULT"], "signature": "VAULT"},
            "physicalCharacteristics": {"heightBuild": "tall", "hair": "short dark hair", "style": "s", "distinguishingMark": "VAULT",
                                         "onCamera": "VAULT"},
            "secrets": ["VAULT"], "trueGoals": "VAULT", "biography": "VAULT", "opinions": {"a": 1}}
    out = ca.photo_sheet_writer_input(card, {"mainPieces": ["a leather jacket"], "spots": {"kitchen": 2}})
    assert out["name"] == "Dev Rao" and out["genderPresentation"] == "man"
    assert out["taken"] == {"mainPieces": ["a leather jacket"], "spots": {"kitchen": 2}}
    assert out["voice"] == {"energy": "low", "register": "dry"}
    assert out["castingType"] == {"label": "the charmer", "read": "easy smile, relaxed confidence"}
    card.pop("castingType")
    assert "castingType" not in ca.photo_sheet_writer_input(card, None)   # older seasons: nothing changes
    assert out["physicalCharacteristics"] == {"heightBuild": "tall", "hair": "short dark hair", "style": "s"}
    assert "VAULT" not in json.dumps(out) and "opinions" not in out and "secrets" not in out


def test_write_photo_sheet_retries_once_with_the_taken_list_then_falls_back():
    card = _npc("man", name="Dev Rao")
    card["id"] = "npc:9"
    taken = {"mainPieces": ["a leather jacket"], "spots": {"kitchen": 3}}
    replies = [
        {"wardrobe": ["a leather jacket", "dark jeans"], "photoHair": "a messy bun", "onCamera": "She stands in the kitchen."},
        {"wardrobe": ["a leather jacket", "dark jeans"], "photoHair": "a neat low bun", "onCamera": "He stands in the kitchen."},
    ]
    sent = []

    async def llm(msgs):
        sent.append(msgs)
        return json.dumps(replies[len(sent) - 1])

    fields, codes = _run(ca.write_photo_sheet(card, taken, llm))
    assert len(sent) == 2
    retry = sent[1][-1]["content"]
    assert "photohair-messy" in retry and "pronoun-mismatch" in retry and "wardrobe-taken" in retry and "leather jacket" in retry
    assert codes == ["wardrobe-taken"]                              # still taken: kept, code reported
    assert fields["wardrobe"][0] == "a leather jacket"             # never drop clothes for this alone
    assert fields["photoHair"] == "a neat low bun" and fields["onCamera"].startswith("He ")


def test_write_photo_sheet_logs_codes_and_ids_never_text():
    lines = []
    lid = ca.logger.add(lambda m: lines.append(str(m)), level="DEBUG") if hasattr(ca.logger, "add") else None
    card = _npc("man")

    async def llm(msgs):
        return json.dumps({"wardrobe": ["a grey SECRETWORD coat", "x"], "photoHair": "SECRETHAIR messy bun",
                           "onCamera": "She says SECRETLINE then leaves the kitchen."})
    try:
        _run(ca.write_photo_sheet(card, None, llm))
    finally:
        if lid is not None:
            ca.logger.remove(lid)
    joined = "".join(lines)
    assert "SECRET" not in joined
    if lid is not None:
        assert "npc:1" in joined and "oncamera-scene" in joined


# ---- the new-cast de-duplication post-pass -----------------------------------------------------------

def _cast_card(i, piece, spot, gender="woman"):
    pron = {"woman": "She", "man": "He", "nonbinary": "They"}[gender]
    return {"id": f"npc:{i}", "name": f"Guest {i}", "age": 30, "genderPresentation": gender,
            "physicalCharacteristics": {"hair": "dark hair", "heightBuild": "tall", "style": "s",
                                         "wardrobe": [piece, "dark jeans"],
                                         "onCamera": f"{pron} stands in the {spot}, arms folded, eyes on the camera, the one who misses nothing."}}


def test_dedupe_rewrites_one_of_each_offender_and_a_clean_cast_makes_zero_calls():
    cards = [_cast_card(1, "a leather jacket", "kitchen"), _cast_card(2, "a leather jacket", "backyard"),
             _cast_card(3, "a green parka", "kitchen"), _cast_card(4, "a navy blazer", "kitchen"),
             _cast_card(5, "a cream cardigan", "kitchen")]
    calls, stored = [], []

    async def llm(msgs):
        inp = json.loads(msgs[1]["content"])
        calls.append(inp)
        # a fix that avoids the taken piece and the full spot
        return json.dumps({"wardrobe": [{"Guest 2": "a rust corduroy blazer", "Guest 5": "a teal rain jacket"}[inp["name"]], "dark jeans"],
                           "photoHair": "a neat low bun",
                           "onCamera": "She sits in the lounge, chin on fist, eyes on the camera, the one who misses nothing."})

    async def write_look(hid, fields):
        stored.append((hid, fields))
        return {"accepted": True}

    n = _run(ca.dedupe_photo_sheets(cards, llm, write_look))
    # npc:2 repeats the leather jacket; npc:5 is the 4th kitchen (npc:1, 3, 4 already there)
    assert [h for h, _ in stored] == ["npc:2", "npc:5"] and n == 2 and len(calls) == 2
    assert calls[0]["name"] == "Guest 2" and calls[0]["genderPresentation"] == "woman"
    assert calls[0]["taken"] == {"mainPieces": ["a leather jacket"], "spots": {"kitchen": 1}}
    assert calls[1]["taken"]["spots"] == {"kitchen": 3, "lounge": 1}


def test_dedupe_clean_cast_makes_zero_extra_calls():
    cards = [_cast_card(1, "a leather jacket", "kitchen"), _cast_card(2, "a flannel shirt", "backyard"),
             _cast_card(3, "a green parka", "lounge"), _cast_card(4, "a navy blazer", "kitchen")]
    calls = []

    async def llm(msgs):
        calls.append(msgs)
        return "{}"

    async def write_look(hid, fields):  # pragma: no cover
        raise AssertionError("nothing to store")

    assert _run(ca.dedupe_photo_sheets(cards, llm, write_look)) == 0
    assert calls == []


def test_dedupe_failures_leave_the_original_sheet():
    cards = [_cast_card(1, "a leather jacket", "kitchen"), _cast_card(2, "a leather jacket", "lounge")]
    stored = []

    async def llm(msgs):
        raise RuntimeError("provider down")

    async def write_look(hid, fields):
        stored.append(hid)
        return {"accepted": True}

    assert _run(ca.dedupe_photo_sheets(cards, llm, write_look)) == 0
    assert stored == []


def _author_npc(i):
    return {"id": f"npc:{i}", "biography": "A seeded floor biography that the engine keeps when the writer omits its own.", "name": f"Guest {i}", "age": 30, "genderPresentation": "woman", "presentation": "soft tailoring",
            "physicalCharacteristics": {"hair": "dark hair", "heightBuild": "tall", "style": "x", "distinguishingMark": "none notable"}}


def test_author_cast_dedupes_then_fires_on_authored_after_the_pass():
    pieces = {1: "a leather jacket", 2: "a leather jacket", 3: "a green parka", 4: "a navy blazer", 5: "a cream cardigan"}
    spots = {1: "kitchen", 2: "kitchen", 3: "kitchen", 4: "kitchen", 5: "backyard"}
    events, writes, looks = [], [], []

    def profile(i):
        return json.dumps({"biography": "A blunt person from Texas who came up the hard way. Friends call her loyal.",
                           "vocation": "rancher",
                           "physicalCharacteristics": {
                               "heightBuild": "tall and lean", "skinTone": "tan", "hair": "dark hair", "facialFeatures": "a square jaw",
                               "distinguishingMark": "none notable", "ageLook": "youthful", "style": "soft tailoring and boots",
                               "wardrobe": [pieces[i], "dark jeans"], "photoHair": "a neat low bun",
                               "onCamera": f"She stands in the {spots[i]}, arms folded, eyes on the camera, the one who misses nothing."}})

    async def llm(msgs):
        user = msgs[1]["content"]
        if msgs[0]["content"] == ca.PHOTO_SHEET_SYSTEM:      # a photo-sheet rewrite
            inp = json.loads(user)
            events.append(("rewrite", inp["name"]))
            return json.dumps({"wardrobe": ["a rust corduroy blazer", "dark jeans"], "photoHair": "a neat low bun",
                               "onCamera": "She sits in the lounge, chin on fist, eyes on the camera, the one who misses nothing."})
        i = int(next(c for c in ("1", "2", "3", "4", "5") if f"npc:{c}" in user or f"Guest {c}" in user))
        return profile(i)

    async def write_fn(p):
        writes.append(p["houseguestId"] if "houseguestId" in p else None)
        return {"accepted": True}

    async def write_look(hid, fields):
        looks.append(hid)
        return {"accepted": True}

    cast = [_author_npc(i) for i in range(1, 6)]
    n = _run(ca.author_cast(cast, llm, write_fn, on_authored=lambda h: events.append(("shoot", h)), look_write_fn=write_look))
    assert n == 5
    rewrites = [e for e in events if e[0] == "rewrite"]
    assert rewrites and looks and set(looks) <= {"npc:2", "npc:4", "npc:5"}
    first_shoot = next(i for i, e in enumerate(events) if e[0] == "shoot")
    assert all(e[0] == "rewrite" for e in events[:first_shoot])         # portraits are requested after the pass
    assert sorted(e[1] for e in events if e[0] == "shoot") == [f"npc:{i}" for i in range(1, 6)]


def test_authoring_instruction_keeps_the_fitness_level_of_the_seeded_build():
    t = ca._SYSTEM
    assert "FITNESS LEVEL" in t and "athletic person stays athletic" in t and "neutral, flattering" in t

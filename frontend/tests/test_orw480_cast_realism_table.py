"""ORW-480: the casting-director table. The Python mirror is byte-identical to the canonical TS-side JSON, the Python tagger tags the
shared fixture (tests/fixtures/orw480_tag_cases.json) as the TS tagger does, and the pass finds what it must on a repetitive cast."""
import json
import os

from src import orwell_cast_realism as R

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIX = json.load(open(os.path.join(ROOT, "tests", "fixtures", "orw480_tag_cases.json")))


def test_the_python_table_is_a_byte_identical_mirror_of_the_canonical_one():
    a = open(os.path.join(ROOT, "src", "domain", "castRealism.json"), "rb").read()
    b = open(os.path.join(ROOT, "frontend", "src", "cast_realism.json"), "rb").read()
    assert a == b


def test_the_tagger_tags_the_shared_fixture_exactly():
    assert len(FIX["cases"]) > 100
    for c in FIX["cases"]:
        assert R.tag_card(c["card"]) == c["tags"], c["card"]
    for text, want in FIX["unreal"]:
        assert R.unreal_clothes(text) == want
    for text, want in FIX["garments"]:
        assert R.is_garment(text) is want


def test_caps_are_a_share_of_the_cast_with_a_floor():
    assert R.cap_for("room", "kitchen", 15) == 3
    assert R.cap_for("sector", "care-and-public-service", 15) == 2
    assert R.cap_for("sector", "trades-labor", 15) == 3
    assert R.cap_for("role", "manager", 15) == 1


def test_a_repetitive_cast_is_over_the_cap_and_only_later_cards_are_offenders():
    card = {"vocation": "nurse", "physicalCharacteristics": {"onCamera": "She sits in the kitchen with a mug, smiling at the camera, the one who listens.",
                                                               "wardrobe": ["blue blazer", "jeans"]}}
    tags = [R.tag_card(card) for _ in range(6)]
    over = R.over_cap(tags)
    assert over["prop"]["mug"] == 6 and over["role"]["nurse"] == 6 and over["sector"]["care-and-public-service"] == 6
    assert R.offenders_for(R.tag_card(card), tags[:2], 15)["prop"] == ["mug"]
    assert "prop" not in R.offenders_for(R.tag_card(card), tags[:1], 15)  # the first two cards keep it


def test_the_live_season_cast_the_reviewers_flagged_is_over_the_cap_where_they_said():
    cards = json.load(open(os.path.join(ROOT, "tests", "fixtures", "orw480_cast_s3_text.json")))
    over = R.over_cap([R.tag_card(c) for c in cards])
    assert over["sector"]["care-and-public-service"] >= 4          # the medical / first responder cluster
    assert over["prop"]["mug"] >= 4 and over["gaze"]["lens"] >= 12 and over["expression"]["smile"] >= 12
    assert over["role"]["manager"] == 2 and over["role"]["coach"] == 2


# ---- real clothes (Track T item 3) -------------------------------------------------------------------------
def _npc(**kw):
    d = {"id": "npc:1", "name": "Namea Surnamea", "genderPresentation": "man", "age": 30, "presentation": "corporate business casual",
         "hometown": "Macon, Georgia"}
    d.update(kw)
    return d


def _prof(wardrobe, style="plain office clothes"):
    return {"physicalCharacteristics": {"heightBuild": "average build", "skinTone": "fair", "hair": "short brown hair", "facialFeatures": "square jaw",
                                        "distinguishingMark": "none notable", "ageLook": "thirties", "style": style, "wardrobe": wardrobe,
                                        "photoHair": "brushed back", "onCamera": "He sits in the kitchen, arms folded, the one who waits."}}


def test_unreal_clothes_and_non_garments_are_look_problems_and_real_ones_are_not():
    from src import orwell_cast_authoring as ca
    ok = _prof(["navy blazer", "white button-down shirt", "grey slacks"])
    assert "wardrobe-unreal" not in ca.look_problems(ok, _npc()) and "wardrobe-not-garment" not in ca.look_problems(ok, _npc())
    for bad in (["navy blazer", "a thin silver lanyard with a badge holder", "grey slacks"], ["fitted charcoal blazer over a bare neckline", "slacks"],
                ["black denim vest with hand-sewn patches", "flannel shirt"]):
        assert "wardrobe-unreal" in ca.look_problems(_prof(bad), _npc()), bad
    assert "wardrobe-unreal" in ca.look_problems(_prof(["navy blazer", "slacks"], style="off-shift comfort worn like a uniform"), _npc())
    assert "wardrobe-not-garment" in ca.look_problems(_prof(["navy blazer", "close-cropped auburn locs worn off the collar"]), _npc())


def test_the_fallback_drops_unreal_clothes_and_an_unreal_style_line():
    from src import orwell_cast_authoring as ca
    prof = _prof(["navy blazer", "a thin silver lanyard"], style="worn like a uniform")
    ca.apply_look_fallbacks(prof, _npc(), ["wardrobe-unreal"])
    assert "wardrobe" not in prof["physicalCharacteristics"] and "uniform" not in prof["physicalCharacteristics"]["style"]


def test_the_prompt_makes_the_style_a_lean_and_asks_for_real_garments():
    from src import orwell_cast_authoring as ca
    assert "a LEAN, not a costume" in ca._SYSTEM and "no work badge, name tag or lanyard" in ca._SYSTEM
    assert "each a real garment or accessory a shop sells" in ca.PHOTO_SHEET_RULES


def test_no_real_wardrobe_piece_from_the_saved_casts_is_flagged_except_the_ones_that_are_not_clothes():
    cards = json.load(open(os.path.join(ROOT, "tests", "fixtures", "orw480_cast_s3_text.json")))
    items = [x for c in cards for x in c["physicalCharacteristics"]["wardrobe"]]
    flagged = [x for x in items if R.unreal_clothes(x) or not R.is_garment(x)]
    assert all("lanyard" in x or "neckline" in x or "hand-sewn" in x for x in flagged), flagged
    assert len(flagged) <= 4


# ---- job sectors at the genesis deal (Track T item 2) ------------------------------------------------------
def test_a_full_job_sector_and_a_repeated_job_word_are_offenders_and_a_new_sector_is_not():
    taken = ["hospice night nurse", "firefighter paramedic"]
    assert R.job_offenders("hospital cafeteria manager", taken, 15)["sector"] == ["care-and-public-service"]
    assert R.job_offenders("paramedic", taken[:1], 15) == {}  # one nurse so far: a second care job is still inside the cap of 2
    assert "role" in R.job_offenders("office manager", ["dental office manager"], 15)
    assert R.job_offenders("tree trimmer", taken, 15) == {}
    hint = R.job_taken_hint(taken, 15)
    assert "care-and-public-service" in hint and "nurse" in hint and "paramedic" in hint
    assert R.job_taken_hint([], 15) == ""


def test_genesis_drops_an_over_cap_job_so_the_engine_floors_the_slot():
    import asyncio
    from src import orwell_cast_genesis as g
    jobs = ["hospice night nurse", "firefighter paramedic", "dental assistant", "tree trimmer", "line cook", "office manager", "school office manager"]
    roster = [{"id": f"npc:{i + 1}", "archetype": "comp-beast"} for i in range(len(jobs))]

    async def llm(messages):
        user = messages[-1]["content"]
        i = next(k for k in range(len(jobs), 0, -1) if f"npc:{k}" in user)
        return json.dumps({"npcs": [{"id": f"npc:{i}", "vocation": jobs[i - 1], "hometown": f"Town{i}, State{i}"}], "ties": []})
    out = asyncio.new_event_loop().run_until_complete(g._gather_chunked_proposal(roster, {"season": "t"}, llm, {n["id"] for n in roster}, None, 1))
    got = {n["id"]: n.get("vocation") for n in out.get("npcs", [])}
    assert got["npc:1"] == "hospice night nurse" and got["npc:2"] == "firefighter paramedic"
    assert got.get("npc:3") is None            # a third care job is over the sector cap of 2
    assert got["npc:4"] == "tree trimmer" and got["npc:5"] == "line cook"
    assert got["npc:6"] == "office manager" and got.get("npc:7") is None  # a second "manager" repeats a job word

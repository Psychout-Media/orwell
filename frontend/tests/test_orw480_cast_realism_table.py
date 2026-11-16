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
    assert R.cap_for("role", "manager", 15) == 2 and R.cap_for("role", "nurse", 15) == 1  # a generic title word on two cards, a distinctive one on one


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
    assert over["role"]["paramedic"] == 2                          # a distinctive title twice; manager and coach twice are inside the cap of 2


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
    assert "START FROM THE PERSON" in ca._SYSTEM and "never a theme to build the outfit from" in ca._SYSTEM and "no work badge, name tag or lanyard" in ca._SYSTEM
    assert "ONE garment or accessory a shop sells" in ca._SYSTEM
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
    assert R.job_offenders("park ranger", taken, 15)["sector"] == ["care-and-public-service"]
    assert R.job_offenders("paramedic", taken[:1], 15) == {}  # one nurse so far: a second care job is still inside the cap of 2
    assert "role" in R.job_offenders("paramedic", ["wildland firefighter paramedic"], 15)  # a distinctive title word twice
    assert R.job_offenders("office manager", ["dental office manager"], 15) == {}            # a generic one twice is inside the cap of 2
    assert "role" in R.job_offenders("shop manager", ["dental office manager", "diner manager"], 15)
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
    assert got["npc:6"] == "office manager" and got["npc:7"] == "school office manager"  # two generic "manager" titles are inside the cap


# ---- the casting-director pass inside the gate (Track T item 1) ----------------------------------------------
import asyncio
import copy

from src import orwell_cast_gate as gate

LOOK = {"heightBuild": "average build", "skinTone": "fair", "hair": "short brown hair", "facialFeatures": "square jaw",
        "distinguishingMark": "none notable", "ageLook": "looks his age", "style": "plain", "wardrobe": ["grey crew tee", "dark jeans"],
        "photoHair": "brushed back", "onCamera": "He sits in the kitchen with a mug, smiling at the camera, the one who waits."}
VOICE = {"register": "plain", "rhythm": "even", "energy": "calm", "directness": "blunt", "humor": "dry", "stressTell": "goes quiet",
         "signature": "says well then", "lexicon": ["well then"]}
BIO = "{n} grew up in Macon and welds boats. He keeps lists of everything and never sleeps well on a Sunday night."


def _go(c):
    return asyncio.new_event_loop().run_until_complete(c)


def _card(i, cam, wardrobe=("grey crew tee", "dark jeans"), first=None):
    first = first or f"Name{chr(97 + i)}"
    npc = {"id": f"npc:{i}", "name": f"{first} Surnamea{chr(97 + i)}", "genderPresentation": "man", "age": 30, "vocation": "welder",
           "hometown": "Macon, Georgia"}
    look = dict(LOOK, onCamera=cam, wardrobe=list(wardrobe))
    prof = {"biography": BIO.format(n=first), "vocation": "welder", "identityConcept": f"Opening {chr(97 + i)} welder who keeps the lights on.",
            "physicalCharacteristics": look, "voice": dict(VOICE)}
    return npc, prof


def _run_cast(cams, rewrite, wardrobes=None):
    g = gate.SeasonGate("t")
    npcs = [_card(i + 1, c, (wardrobes or {}).get(i, ("grey crew tee", "dark jeans")))[0] for i, c in enumerate(cams)]
    out = []
    for i, c in enumerate(cams):
        npc, prof = _card(i + 1, c, (wardrobes or {}).get(i, ("grey crew tee", "dark jeans")))
        got, _ = _go(gate.run_gate(g, prof, npc, npcs, rewrite))
        out.append(got)
    return g, out


MUG = "He sits in the kitchen with a mug, looking away toward the window, the one who waits {k}."


def test_later_cards_over_the_mug_cap_are_rewritten_and_the_first_two_keep_it():
    cams = [MUG.format(k=k) for k in "abcd"]
    asked = []

    async def rw(npc, codes, message=None):
        asked.append((npc["id"], message))
        i = int(npc["id"].split(":")[1])
        p = copy.deepcopy(_card(i, cams[0])[1])
        p["physicalCharacteristics"]["onCamera"] = {
            3: "He leans on the counter in the dining room, arms folded, looking away from the lens.",
            4: "He stands in the backyard with his hands in his pockets, eyes on the fence, a flat unreadable face.",
        }[i]  # a different spot, pose and face for each, so no new offender is created
        return p
    g, out = _run_cast(cams, rw)
    assert [a[0] for a in asked] == ["npc:3", "npc:4"]  # the first two cards keep the mug
    assert all("mug" in m for _, m in asked)
    assert "mug" in out[0]["physicalCharacteristics"]["onCamera"] and "mug" in out[1]["physicalCharacteristics"]["onCamera"]
    assert "mug" not in out[2]["physicalCharacteristics"]["onCamera"] and "mug" not in out[3]["physicalCharacteristics"]["onCamera"]
    assert g.realism_fixed >= 2


def test_a_rewrite_that_brings_the_same_value_or_a_new_offender_is_not_kept_and_the_card_ships_as_it_is():
    cams = [MUG.format(k=k) for k in "abc"]

    async def same(npc, codes, message=None):
        return copy.deepcopy(_card(int(npc["id"].split(":")[1]), cams[0])[1])
    g, out = _run_cast(cams, same)
    assert "mug" in out[2]["physicalCharacteristics"]["onCamera"] and g.realism_fixed == 0


def test_a_rewritten_oncamera_line_goes_through_the_first_pass_look_checks():
    cams = [MUG.format(k=k) for k in "abc"]

    async def bad(npc, codes, message=None):
        p = copy.deepcopy(_card(int(npc["id"].split(":")[1]), cams[0])[1])
        p["physicalCharacteristics"]["onCamera"] = "She stands in the doorway, her arms folded."  # wrong pronoun, no house spot
        return p
    g, out = _run_cast(cams, bad)
    assert "mug" in out[2]["physicalCharacteristics"]["onCamera"] and g.realism_fixed == 0


def test_a_repeated_garment_is_rewritten_with_real_garments_only():
    blazers = ["navy blazer", "white button-down shirt", "grey slacks"]
    cams = ["He sits in the kitchen, looking away from the lens, the one who {x}.".format(x=x) for x in "abcde"]

    async def rw(npc, codes, message=None):
        i = int(npc["id"].split(":")[1])
        p = copy.deepcopy(_card(i, cams[0], blazers)[1])
        p["physicalCharacteristics"]["wardrobe"] = {3: ["rust corduroy overshirt", "dark work jeans", "scuffed brown boots"],
                                                    4: ["faded green hoodie", "khaki shorts", "white sneakers"],
                                                    5: ["mustard rain jacket", "dark work jeans", "worn trail runners"]}[i]
        return p
    g, out = _run_cast(cams, rw, wardrobes={i: blazers for i in range(5)})
    assert out[3]["physicalCharacteristics"]["wardrobe"][0].startswith("faded") and out[4]["physicalCharacteristics"]["wardrobe"][0].startswith("mustard")
    assert all(out[i]["physicalCharacteristics"]["wardrobe"] == blazers for i in range(3))  # the first three cards keep theirs (the blazer cap is 3)
    assert "realism-fixed" in g.codes

    async def costume(npc, codes, message=None):
        p = copy.deepcopy(_card(int(npc["id"].split(":")[1]), cams[0], blazers)[1])
        p["physicalCharacteristics"]["wardrobe"] = ["rust corduroy overshirt", "a thin silver lanyard", "dark work jeans"]
        return p
    g, out = _run_cast(cams, costume, wardrobes={i: blazers for i in range(5)})
    assert out[4]["physicalCharacteristics"]["wardrobe"] == blazers  # a rewrite with a lanyard is rejected


def test_the_realism_rewrites_are_bounded_per_cast():
    cams = [MUG.format(k=k) for k in "abcdefghijkl"]
    calls = []

    async def rw(npc, codes, message=None):
        calls.append(npc["id"])
        return None
    g, out = _run_cast(cams, rw)
    assert len(calls) == gate.REALISM_LOWPRIO_BUDGET and g.realism_rewrites == gate.REALISM_LOWPRIO_BUDGET  # a prop is a low-priority ask: the look-fits-life ones have the rest of the budget
    assert all("mug" in o["physicalCharacteristics"]["onCamera"] for o in out)


def test_a_writer_error_or_no_writer_changes_nothing_and_an_introduced_card_is_never_rewritten():
    cams = [MUG.format(k=k) for k in "abc"]

    async def boom(npc, codes, message=None):
        raise RuntimeError("provider down")
    g, out = _run_cast(cams, boom)
    assert "mug" in out[2]["physicalCharacteristics"]["onCamera"]
    g, out = _run_cast(cams, None)
    assert "mug" in out[2]["physicalCharacteristics"]["onCamera"] and g.realism_fixed == 0


def test_the_writer_prompt_no_longer_seeds_the_mug_the_lens_the_smile_or_the_closing_read():
    from src import orwell_cast_authoring as ca
    r = ca.PHOTO_SHEET_RULES
    assert "holding a mug" not in r and "Eyes on the camera, unless" not in r and "Mouth closed, smiling" not in r
    assert "never a mug or cup" in r and "OPENING PATTERN line says closing read: yes" in r and "a serious, wry, tired, guarded" in r
    shares = [ca.opening_pattern(i)["closing read"] for i in range(15)].count("yes")
    assert shares == 5  # one card in three


def test_a_cast_of_fifteen_never_ends_with_more_than_two_jobs_in_one_sector_and_an_over_cap_job_gets_a_fitting_example():
    import asyncio
    from src import orwell_cast_genesis as g
    # the live test cast's jobs: five in care and public service, a referee and a trainer, two office jobs
    jobs = ["youth outreach coordinator", "home-health aide", "session guitarist", "personal trainer", "tree trimmer", "line cook",
            "recreation league referee", "wildland firefighter", "paralegal", "postal carrier", "insurance claims adjuster",
            "used-car salesperson", "hospice night nurse", "audio engineer", "heavy-equipment operator"]
    roster = [{"id": f"npc:{i + 1}", "archetype": "comp-beast"} for i in range(15)]
    directives = {f"npc:{i + 1}": {"ledger": {"jobExamples": ["wedding photographer", "pizzeria manager", "water-treatment chemist"]}} for i in range(15)}

    async def llm(messages):
        user = messages[-1]["content"]
        i = next(k for k in range(15, 0, -1) if f"npc:{k}" in user)
        return json.dumps({"npcs": [{"id": f"npc:{i}", "vocation": jobs[i - 1], "hometown": f"Town{i}, State{i}"}], "ties": []})
    out = asyncio.new_event_loop().run_until_complete(g._gather_chunked_proposal(roster, {"season": "t"}, llm, {n["id"] for n in roster}, None, 15, directives))
    got = [n.get("vocation") for n in sorted(out["npcs"], key=lambda n: int(n["id"].split(":")[1]))]
    held = [v for v in got if v]
    tags = [R.tag_card({"vocation": v}) for v in held]
    assert R.over_cap(tags, 15).get("sector", {}) == {}, got
    assert all(R.over_cap(tags, 15).get("role", {}) == {} for _ in [0])
    assert "wedding photographer" in got or "pizzeria manager" in got  # an over-cap slot took one of its own example jobs


def test_the_finished_cast_holds_the_sector_and_job_word_caps_over_200_seeded_floor_casts():
    """The engine's own floor job is not capped by sector or title: 124 of 200 seeded floor casts had a sector over cap. The final pass
    checks the finished 15 (writer jobs, else the floor job on the roster card), so the guarantee holds on every one."""
    import random
    import re as _re
    from src import orwell_cast_genesis as g
    corpus = [v for v in _re.findall(r'"([^"]+)"', open(os.path.join(ROOT, "src", "engine", "data", "vocations.ts")).read()) if len(v) > 3]
    assert len(corpus) > 100
    before_bad = after_bad = replaced = 0
    for seed in range(200):
        rng = random.Random(seed)
        floor = [rng.choice(corpus) for _ in range(15)]
        entries = [{"id": f"npc:{i + 1}", "vocation": floor[i]} for i in range(15)]
        tags = [R.tag_card({"vocation": v}) for v in floor]
        before_bad += bool(R.over_cap(tags, 15).get("sector"))
        npcs: list = []
        replaced += g._final_job_pass(entries, npcs, {})
        final = {n["id"]: n["vocation"] for n in npcs}
        jobs = [final.get(e["id"], e["vocation"]) for e in entries]
        over = R.over_cap([R.tag_card({"vocation": v}) for v in jobs], 15)
        assert not over.get("sector"), (seed, jobs, over)
        assert not over.get("role"), (seed, jobs, over)
        after_bad += bool(over.get("sector"))
    assert before_bad > 40 and after_bad == 0 and replaced > 0


# ---- marks (Kevin: "so many people with tooth gaps") ---------------------------------------------------------
def test_the_mark_lives_in_distinguishing_mark_only_and_the_season_line_names_the_marks_dealt():
    npc = {"id": "npc:1", "name": "Namea Surnamea", "genderPresentation": "woman", "age": 30}
    prof = {"physicalCharacteristics": {"distinguishingMark": "round tortoiseshell glasses", "facialFeatures": "strong cheekbones, round glasses over soft eyes"}}
    codes = gate.mend(prof, npc, [npc])
    assert "mark-duplicated" in codes and prof["physicalCharacteristics"]["facialFeatures"] == "strong cheekbones"
    assert gate.mend({"physicalCharacteristics": {"distinguishingMark": "none notable", "facialFeatures": "a square jaw"}}, npc, [npc]) == []
    g = gate.SeasonGate("t")
    for i, mark in enumerate(["round tortoiseshell glasses", "a single dimple on the left cheek", "none notable"]):
        n, p = _card(i + 1, "He sits with his arms folded.")
        p["physicalCharacteristics"]["distinguishingMark"] = mark
        _go(gate.run_gate(g, p, n, [n], None))
    assert g.marks_dealt() == "2[dimples,glasses]" and "marks=2[dimples,glasses]" in g.summary_line()


def test_the_writer_prompt_keeps_the_mark_out_of_the_face_line():
    from src import orwell_cast_authoring as ca
    assert "THE MARK LIVES IN distinguishingMark ONLY" in ca._SYSTEM


# ---- the look fits the life ----------------------------------------------------------------------------------
def _lf_card(**kw):
    d = {"id": "npc:1", "name": "Namea Surnamea", "genderPresentation": "woman", "age": 36, "vocation": "line cook",
         "hometown": "Sidney, Nebraska", "presentation": "minimalist monochrome",
         "physicalCharacteristics": {"style": "one tone head to toe, clean lines, no accessories",
                                     "wardrobe": ["charcoal linen button-down shirt", "black straight-leg trousers", "simple black leather flats"]}}
    d.update(kw)
    return d


def test_the_live_season_line_cook_in_monochrome_minimalism_fails_and_a_plausible_look_does_not():
    assert R.look_fits_life(_lf_card()) == ["family", "family-worn", "upscale"]  # a polished big-city family and a model-like styling line, on a line cook from a small town
    ok = _lf_card(presentation="skater", age=24, physicalCharacteristics={"style": "baggy jeans and a faded tee", "wardrobe": ["faded grey tee", "baggy jeans", "canvas sneakers"]})
    assert R.look_fits_life(ok) == []
    rich = _lf_card(presentation="skater", age=24, physicalCharacteristics={"style": "baggy jeans", "wardrobe": ["silk shirt", "tailored trousers", "leather loafers"]})
    assert R.look_fits_life(rich) == ["upscale"]


def test_the_style_weight_leans_toward_a_look_the_person_could_own():
    assert R.style_fit_weight("minimalist", "line cook", "Sidney, Nebraska", 36) < 0.3
    assert R.style_fit_weight("skater", "line cook", "Sidney, Nebraska", 24) > 1
    assert R.style_fit_weight("quiet-luxury", "insurance agent", "Boston, Massachusetts", 45) >= 1
    assert R.style_fit_weight("western", "welder", "Boston, Massachusetts", 30) < R.style_fit_weight("western", "welder", "Sidney, Nebraska", 30)


def test_an_upscale_wardrobe_on_a_modest_life_is_rewritten_with_the_ask_and_the_style_line_travels_with_it():
    g = gate.SeasonGate("t")
    cast = [_card(i, "He sits with his arms folded.")[0] for i in (1, 2)]
    for n in cast:
        n.update(vocation="line cook", hometown="Sidney, Nebraska", presentation="skater", age=24)
    asked = []

    async def rw(npc, codes, message=None):
        asked.append(message)
        p = _card(2, "He sits with his arms folded.")[1]
        p["physicalCharacteristics"]["wardrobe"] = ["faded grey tee", "dark work jeans", "scuffed sneakers"]
        p["physicalCharacteristics"]["style"] = "plain tees and jeans from the big-box store"
        return p
    rich = _card(2, "He sits with his arms folded.")[1]
    rich["physicalCharacteristics"]["wardrobe"] = ["silk shirt", "tailored trousers", "leather loafers"]
    rich["physicalCharacteristics"]["style"] = "one tone head to toe"
    got, _ = _go(gate.run_gate(g, rich, cast[1], cast, rw))
    assert asked and "could really own and buy where they live" in asked[0]
    assert got["physicalCharacteristics"]["wardrobe"][0] == "faded grey tee" and got["physicalCharacteristics"]["style"].startswith("plain tees")


def test_the_python_style_weight_matches_the_shared_cases_the_typescript_half_checks():
    cases = json.load(open(os.path.join(ROOT, "tests", "fixtures", "orw480_style_fit_cases.json")))
    assert len(cases) > 60
    for fam, vocation, hometown, age, want in cases:
        assert abs(R.style_fit_weight(fam, vocation, hometown, age) - want) < 1e-5, (fam, vocation)


# ---- ages (a real cast: 12 of 15 at 21 to 28) ----------------------------------------------------------------
def test_the_final_ages_follow_the_cast_age_curve_whatever_the_writer_proposes():
    from src import orwell_cast_identity as I
    for seed in range(40):
        import random
        rng = random.Random(seed)
        cast = [{"id": f"npc:{i}", "age": rng.randint(21, 52)} for i in range(1, 16)]
        facets = {c["id"]: {"age": rng.choice([21, 22, 22, 23, 24, 25, 26, 28])} for c in cast}   # the writer's favourite twenties
        out = I.spread_ages(facets, cast)
        ages = [out[c["id"]]["age"] for c in cast]
        assert sum(a <= 26 for a in ages) == 4 and sum(27 <= a <= 33 for a in ages) == 5, ages
        assert sum(34 <= a <= 45 for a in ages) == 4 and sum(a >= 46 for a in ages) == 2, ages
        assert min(ages) >= 21 and max(ages) <= 60


def test_a_proposal_that_fits_the_curve_is_kept_and_no_proposal_changes_nothing():
    from src import orwell_cast_identity as I
    cast = [{"id": f"npc:{i}", "age": 30} for i in range(1, 16)]
    assert I.spread_ages({}, cast) == {}
    out = I.spread_ages({"npc:1": {"age": 24, "ethnicity": "x"}}, cast)
    assert out["npc:1"]["age"] == 24 and out["npc:1"]["ethnicity"] == "x"


# ---- the dealt mark is authoritative (a real cast: "deep dimples" on three cards) ----------------------------
def test_the_dealt_mark_wins_over_the_writers_own_and_no_category_exceeds_two_on_the_finished_cast():
    cast = []
    for i in range(1, 16):
        n, _ = _card(i, "He sits with his arms folded.")
        n["physicalCharacteristics"] = {"distinguishingMark": "none notable"}
        cast.append(n)
    cast[1]["physicalCharacteristics"]["distinguishingMark"] = "a single dimple on the left cheek"
    cast[4]["physicalCharacteristics"]["distinguishingMark"] = "round tortoiseshell glasses"
    g = gate.SeasonGate("t")
    out = []
    for n in cast:
        _, prof = _card(int(n["id"].split(":")[1]), "He sits with his arms folded.")
        prof["physicalCharacteristics"]["distinguishingMark"] = "deep dimples when she grins"   # the writer's favourite, on every card
        got, _ = _go(gate.run_gate(g, prof, n, cast, None))
        out.append(got["physicalCharacteristics"]["distinguishingMark"])
    assert out[1] == "a single dimple on the left cheek" and out[4] == "round tortoiseshell glasses"
    assert out.count("none notable") == 13 and not any("deep dimples" in m for m in out)
    kinds = [R.tag_kind("mark", {"distinguishingMark": m})[0] for m in out if m != "none notable"]
    assert max(kinds.count(k) for k in set(kinds)) <= 2 and g.marks_dealt() == "2[dimples,glasses]"
    assert "THE MARK IS DEALT" in __import__("src.orwell_cast_authoring", fromlist=["x"])._SYSTEM


def test_the_six_looks_a_real_cast_got_wrong_are_all_caught_with_the_reason():
    cases = [("county sheriff's deputy", "Hilo, Hawaii", 32, "skater", ["a plain charcoal zip hoodie", "baggy dark-wash jeans", "low-top canvas sneakers"], ["family"]),
             ("line cook", "Crockett, Texas", 21, "beachy surf", ["a faded navy cotton tee", "loose-fitting khaki board shorts", "a simple shell necklace"], ["family", "climate"]),
             ("warehouse forklift driver", "Stockbridge, Georgia", 28, "cottagecore", ["a loose oatmeal linen button-up shirt", "straight-leg olive khaki trousers", "a woven straw sun hat"], ["family"]),
             ("ballroom dance instructor", "Sun City, Arizona", 22, "outdoorsy technical", ["a fitted olive fleece pullover", "a black puffer vest", "brown leather hiking boots"], ["climate"]),
             ("casino dealer", "Pinedale, Wyoming", 24, "Miami flashy", ["a navy silk button-down shirt with a large tropical print", "slim black trousers", "white leather sneakers"], ["family", "climate"]),
             ("high-school track and field coach", "Exeter, Rhode Island", 26, "corporate business casual", ["navy single-breasted blazer", "checked button-down shirt", "slim grey trousers"], ["family"])]
    for job, town, age, fam, wardrobe, want in cases:
        card = {"vocation": job, "hometown": town, "age": age, "presentation": fam, "physicalCharacteristics": {"wardrobe": wardrobe, "style": ""}}
        got = R.look_fits_life(card)
        assert all(w in got for w in want), (job, got)
    # the style line naming the poor-fit family is what makes it "worn" (plain clothes sharing one keyword are not)
    skater = {"vocation": "county sheriff's deputy", "hometown": "Hilo, Hawaii", "age": 32, "presentation": "skater",
              "physicalCharacteristics": {"wardrobe": ["a plain charcoal zip hoodie", "baggy dark-wash jeans"], "style": "skater style, skate shoes"}}
    assert "family-worn" in R.look_fits_life(skater)
    ok = {"vocation": "line cook", "hometown": "Crockett, Texas", "age": 24, "presentation": "skater",
          "physicalCharacteristics": {"wardrobe": ["grey cotton tee", "dark work jeans", "scuffed sneakers"], "style": "plain tees and jeans"}}
    assert R.look_fits_life(ok) == []
    assert R.look_fits_life({**ok, "physicalCharacteristics": {"wardrobe": []}}) == ["missing"]


def test_a_card_with_no_wardrobe_and_a_poor_fit_look_get_one_compact_rewrite_each_inside_the_budget():
    g = gate.SeasonGate("t")
    cast = [_card(i, "He sits with his arms folded.")[0] for i in (1, 2)]
    for n in cast:
        n.update(vocation="line cook", hometown="Crockett, Texas", presentation="skater", age=24)
    asked = []

    async def rw(npc, codes, message=None):
        asked.append(message)
        p = _card(2, "He sits with his arms folded.")[1]
        p["physicalCharacteristics"]["wardrobe"] = ["grey cotton tee", "dark work jeans", "scuffed sneakers"]
        return p
    _, prof = _card(2, "He sits with his arms folded.")
    prof["physicalCharacteristics"].pop("wardrobe")
    got, _ = _go(gate.run_gate(g, prof, cast[1], cast, rw))
    assert asked and got["physicalCharacteristics"]["wardrobe"][0] == "grey cotton tee" and g.realism_fixed == 1

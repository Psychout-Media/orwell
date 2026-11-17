"""ORW-563: a look that is a strong outlier for the whole person (a cottagecore cardigan on a rural car-lot flirt) is caught by the cast gate
with the code believability:look-life and re-picked among plausible families; every other look stands. Kevin: look 10-35% typical is a normal
person, the far outlier reads as an error, and do not over-correct: the flagged share over seeded casts must stay a few percent."""
import json
import os

from src import orwell_cast_gate as gate
from src import orwell_cast_realism as R
from src.orwell_style_families import STYLE_FAMILIES, family_for_label
from test_orw480_cast_realism_table import _card, _go

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LIVES = [[dict(zip(("vocation", "hometown", "age", "presentation", "background"), p)) for p in cast]
         for cast in json.load(open(os.path.join(ROOT, "tests", "fixtures", "orw563_dealt_lives.json")))]

CASS = {"name": "Cass Bell", "age": 27, "vocation": "used-car salesperson", "hometown": "Carey, Ohio", "presentation": "cottagecore",
        "background": "grew up working the family lot off a two-lane highway"}
BAKER = {"name": "Ana Ruiz", "age": 29, "vocation": "small-farm baker", "hometown": "Plain City, Ohio", "presentation": "cottagecore",
         "background": "grew up on a small farm"}


def test_cass_is_flagged_and_a_believable_cottagecore_person_is_not():
    assert R.believability_look_life(CASS) == [R.CODE_LOOK_LIFE]
    assert R.believability_look_life(BAKER) == []
    assert R.believability_look_life({**BAKER, "vocation": "kindergarten teacher", "background": "grew up in town"}) == []
    # the same job in another look is fine: it is the pairing that is the outlier
    assert R.believability_look_life({**CASS, "presentation": "western"}) == []
    # one moderate mismatch is not an outlier (a cottagecore insurance agent: the job world only)
    assert R.believability_look_life({**CASS, "vocation": "insurance agent", "background": "grew up in town"}) == []


def test_the_repick_is_plausible_stable_free_and_never_an_outlier():
    got = R.repick_look(CASS, {"preppy and buttoned-up"})
    assert got and got != "preppy and buttoned-up" and got != "cottagecore"
    assert R.repick_look(CASS, {"preppy and buttoned-up"}) == got
    assert not R.believability_look_life({**CASS, "presentation": got})
    assert R.repick_look(CASS, {f["label"] for f in STYLE_FAMILIES}) is None


def test_the_gate_counts_the_outlier_code_but_does_not_change_the_card():
    g = gate.SeasonGate("t")
    npc, prof = _card(1, "He sits with his arms folded.")
    npc.update(name="Cass Bell", vocation="used-car salesperson", hometown="Carey, Ohio", age=27, presentation="cottagecore",
               background="grew up working the family lot off a two-lane highway")
    prof["vocation"] = "used-car salesperson"
    prof["physicalCharacteristics"]["style"] = "a cottagecore look: a cream knit cardigan and a floral skirt"
    got, codes = _go(gate.run_gate(g, prof, npc, [npc], None))
    assert "believability:look-life" in codes and g.codes.get("believability:look-life") == 1
    assert "presentation" not in got and npc["presentation"] == "cottagecore"  # the cast-level judge decides who is re-picked


def test_a_mismatched_label_with_a_believable_written_wardrobe_is_not_flagged_and_is_never_re_picked():
    cara = {"id": "npc:2", "name": "Cara Engel", "age": 30, "vocation": "sawmill yard hand", "hometown": "Grayling, MI", "presentation": "preppy and buttoned-up",
            "background": "grew up on a dirt road with a lumberjack father",
            "physicalCharacteristics": {"style": "a worn grey hoodie and work jeans", "wardrobe": ["worn grey hoodie", "work jeans", "scuffed boots"]}}
    assert R.believability_look_life(cara) == []
    # the judge is told to judge the written look (wardrobe, style, signature, interests); the label rides as context only
    msgs = B.judge_messages([cara], {})
    assert "labelContextOnly" in msgs[1]["content"] and "worn grey hoodie" in msgs[1]["content"] and "context only" in msgs[0]["content"]
    assert "interests" in msgs[1]["content"]
    # a failed judge falls back to the deterministic check, which also leaves her alone: no write, no churn
    cards = [cara, {**_cast()[2]}]
    fake = Fake("", fail_judge=True)
    assert _run_pass(cards, fake) == 0 and not fake.writes and cards[0]["presentation"] == "preppy and buttoned-up"


def test_sawmill_and_logger_jobs_are_a_sector_and_cara_is_an_outlier_for_the_deterministic_fallback():
    assert R.life_sector("sawmill yard hand") == "trades-labor"
    cara = {"name": "Cara Engel", "age": 30, "vocation": "sawmill yard hand", "hometown": "Grayling, MI", "presentation": "preppy and buttoned-up",
            "background": "grew up on a dirt road with a lumberjack father",
            "physicalCharacteristics": {"style": "preppy oxford and chinos", "wardrobe": ["oxford shirt", "chinos"]}}
    assert R.believability_look_life(cara) == [R.CODE_LOOK_LIFE]


# ---- the cast-level judge (the model is mocked: this tests the plumbing) --------------------------------------------
import asyncio

from src import orwell_cast_believability as B

WARD = ["faded denim jacket", "dark work jeans", "scuffed boots"]
PHYS = {"heightBuild": "average build", "hair": "short brown hair", "style": "a cream knit cardigan, a floral skirt", "wardrobe": ["cream knit cardigan", "floral skirt"]}


def _cast():
    cass = {"id": "npc:1", "name": "Cass Bell", "age": 27, "vocation": "used-car salesperson", "hometown": "Carey, Ohio", "archetype": "flirt",
            "demeanor": "smooth and charming", "presentation": "cottagecore", "background": "grew up working the family lot off a two-lane highway",
            "physicalCharacteristics": dict(PHYS, style="a cottagecore look: a cream knit cardigan and a floral skirt"),
            "biography": "Cass keeps a garden and a sourdough starter."}
    cara = {"id": "npc:2", "name": "Cara Engel", "age": 30, "vocation": "sawmill yard hand", "hometown": "Grayling, MI", "archetype": "loyalist",
            "demeanor": "quiet and watchful", "presentation": "preppy and buttoned-up", "background": "grew up on a dirt road with a lumberjack father",
            "physicalCharacteristics": dict(PHYS, style="preppy oxford and chinos", wardrobe=["oxford shirt", "chinos"])}
    ok = {"id": "npc:3", "name": "Ana Ruiz", "age": 29, "vocation": "small-farm baker", "hometown": "Plain City, Ohio", "archetype": "peacemaker",
          "demeanor": "sweet and earnest", "presentation": "bohemian", "background": "grew up on a small farm",
          "physicalCharacteristics": dict(PHYS)}
    return [cass, cara, ok]


class Fake:
    def __init__(self, judge_reply, fail_judge=False, rewrite_ok=True):
        self.judge_reply, self.fail_judge, self.rewrite_ok = judge_reply, fail_judge, rewrite_ok
        self.calls = []; self.writes = []; self.looks = []

    async def llm(self, messages):
        self.calls.append(messages)
        if "believable as a whole person" in messages[0]["content"]:
            if self.fail_judge:
                raise RuntimeError("boom")
            return self.judge_reply
        return json.dumps({"wardrobe": WARD, "style": "plain denim and boots"} if self.rewrite_ok else {"nonsense": 1})

    async def write(self, req):
        self.writes.append(req)
        return {"accepted": True, "publicFields": ["presentation"]}

    async def look(self, hid, fields):
        self.looks.append((hid, fields))
        return {"accepted": True}


def _run_pass(cards, fake, stats=None):
    taken = {c["presentation"] for c in cards}
    return _go(B.believability_pass(cards, taken, fake.llm, fake.write, fake.look, stats=stats if stats is not None else {}))


def test_the_judge_flags_cass_and_cara_and_not_the_believable_cottagecore_baker():
    cards = _cast()
    fake = Fake(json.dumps({"flagged": [{"id": "npc:1", "reason": "cottagecore on a rural car-lot flirt", "pick": ""},
                                        {"id": "npc:2", "reason": "preppy on a lumber yard hand", "pick": "not a candidate"}]}))
    stats = {}
    assert _run_pass(cards, fake, stats) == 1  # a third of 3 cards: only the strongest flag is kept
    assert stats["calls"] == 1 and stats["flagged"] == 1 and stats["capped"] == 1 and stats["repicked"] == 1
    assert len(fake.writes) == 1 and fake.writes[0]["houseguestId"] in ("npc:1", "npc:2")
    hid = fake.writes[0]["houseguestId"]
    card = next(c for c in cards if c["id"] == hid)
    assert card["presentation"] == fake.writes[0]["presentation"] and card["presentation"] not in ("cottagecore", "preppy and buttoned-up")
    assert fake.looks and fake.looks[0][1]["wardrobe"] == WARD and card["physicalCharacteristics"]["wardrobe"] == WARD
    assert next(c for c in cards if c["id"] == "npc:3")["presentation"] == "bohemian"


def test_a_valid_candidate_named_by_the_judge_is_used_and_an_invalid_one_is_not():
    cards = _cast()
    cands = R.look_candidates(cards[0], {c["presentation"] for c in cards} - {"cottagecore"})
    assert cands
    fake = Fake(json.dumps({"flagged": [{"id": "npc:1", "reason": "x", "pick": cands[-1]}]}))
    assert _run_pass(cards, fake) == 1 and fake.writes[0]["presentation"] == cands[-1]
    cards = _cast()
    fake = Fake(json.dumps({"flagged": [{"id": "npc:1", "reason": "x", "pick": "Miami flashy"}]}))
    assert _run_pass(cards, fake) == 1 and fake.writes[0]["presentation"] != "Miami flashy"


def test_junk_or_a_failed_call_falls_back_to_the_deterministic_check_and_never_crashes():
    for fake in (Fake("this is not json at all"), Fake('{"flagged": "no"}'), Fake("", fail_judge=True), Fake("[1,2]")):
        cards = _cast()
        stats = {}
        done = _run_pass(cards, fake, stats)
        assert stats["fallback"] == 1 and stats["calls"] == 1
        assert done == 1  # the deterministic check flags both Cass and Cara; a third of 3 keeps the strongest one
        assert len(fake.writes) == 1 and next(c for c in cards if c["id"] == "npc:3")["presentation"] == "bohemian"


def test_parse_verdict_drops_unknown_ids_and_junk_entries():
    ids = {"npc:1", "npc:2"}
    got = B.parse_verdict('{"flagged": [{"id": "npc:1", "reason": "r", "pick": "x"}, {"id": "ghost"}, 5, {"id": "npc:1"}]}', ids, {"npc:1": ["a"]})
    assert got == {"npc:1": {"reason": "r", "pick": None}}
    assert B.parse_verdict('{"flagged": []}', ids, {}) == {}
    for junk in (None, "", "nope", '{"x": 1}', 12):
        assert B.parse_verdict(junk, ids, {}) is None


def test_a_card_whose_clothes_cannot_be_rewritten_goes_back_to_its_dealt_family():
    cards = _cast()
    fake = Fake(json.dumps({"flagged": [{"id": "npc:1", "reason": "x", "pick": ""}]}), rewrite_ok=False)
    stats = {}
    assert _run_pass(cards, fake, stats) == 0
    assert stats["reverted"] == 1 and cards[0]["presentation"] == "cottagecore"
    assert [w["presentation"] for w in fake.writes][-1] == "cottagecore" and not fake.looks


def test_the_cap_keeps_only_about_a_third_of_a_cast_and_the_strongest():
    cards = _cast()
    flags = {c["id"]: {"reason": "", "pick": None} for c in cards}
    kept, dropped = B.cap_flags(flags, {c["id"]: c for c in cards}, 15)
    assert len(kept) == 3 and dropped == 0
    many = {f"npc:{i}": {"reason": "", "pick": None} for i in range(1, 11)}
    cast15 = {k: {**cards[2], "id": k, "presentation": "bohemian"} for k in many}
    cast15["npc:7"] = {**cards[0], "id": "npc:7"}  # Cass is by far the weakest fit: she is always kept
    kept, dropped = B.cap_flags(many, cast15, 15)
    assert len(kept) == 5 and dropped == 5 and "npc:7" in kept


def test_over_100_seeded_casts_only_a_few_percent_are_outliers_and_the_cast_keeps_its_variety():
    total = flagged = 0
    families = set()
    per_cast = []
    for cast in LIVES:
        taken = {p["presentation"] for p in cast}
        distinct = set()
        for p in cast:
            total += 1
            card = {**p, "name": p["vocation"] + str(p["age"])}
            if R.believability_look_life(card):
                flagged += 1
                new = R.repick_look(card, taken - {p["presentation"]})
                assert new and not R.believability_look_life({**card, "presentation": new})
                taken.add(new)
                p = {**p, "presentation": new}
            distinct.add(p["presentation"])
            families.add(p["presentation"])
        per_cast.append(len(distinct))
    share = flagged / total
    assert 0.005 < share < 0.05, share  # measured 2.4% over 1,500 lives: a few percent, concentrated on far outliers
    assert len(families) >= 28 and min(per_cast) >= 12  # still 30 families in use and a varied cast (one family per houseguest)

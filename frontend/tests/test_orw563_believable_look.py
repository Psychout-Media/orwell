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


def test_the_gate_repicks_cass_and_leaves_a_fitting_card_alone():
    g = gate.SeasonGate("t")
    npc, prof = _card(1, "He sits with his arms folded.")
    npc.update(name="Cass Bell", vocation="used-car salesperson", hometown="Carey, Ohio", age=27, presentation="cottagecore",
               background="grew up working the family lot off a two-lane highway")
    prof["vocation"] = "used-car salesperson"
    asked = []

    async def rw(n, codes, message=None):
        asked.append(message)
        p = _card(1, "He sits with his arms folded.")[1]
        p["physicalCharacteristics"]["wardrobe"] = ["faded denim jacket", "dark work jeans", "scuffed boots"]
        p["physicalCharacteristics"]["style"] = "plain denim and boots from the shop on the highway"
        return p
    got, codes = _go(gate.run_gate(g, prof, npc, [npc], rw))
    new = got["presentation"]
    assert new != "cottagecore" and family_for_label(new) and npc["presentation"] == new
    assert g.codes.get("believability:look-life") == 1 and g.codes.get("believability-repicked") == 1
    assert R.believability_look_life({**npc, **got}) == [] and "believability:look-life" not in codes
    assert asked and "could really own and buy where they live" in asked[0]
    assert got["physicalCharacteristics"]["wardrobe"][0] == "faded denim jacket"
    # a fitting card: untouched, nothing re-picked, no rewrite asked
    g2 = gate.SeasonGate("t")
    npc2, prof2 = _card(2, "He sits with his arms folded.")
    npc2.update(name="Ana Ruiz", vocation="small-farm baker", hometown="Plain City, Ohio", age=29, presentation="cottagecore", background="grew up on a small farm")
    prof2["vocation"] = "small-farm baker"
    asked.clear()
    got2, _ = _go(gate.run_gate(g2, prof2, npc2, [npc2], rw))
    assert "presentation" not in got2 and npc2["presentation"] == "cottagecore" and not g2.repicked and "believability" not in "".join(m or "" for m in asked)


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

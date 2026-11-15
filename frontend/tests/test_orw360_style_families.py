"""ORW-360: style families (TS/FE parity) and the look accept-path checks."""
import asyncio
import json
import os
import re

from src import orwell_cast_authoring as ca
from src import orwell_style_families as sf

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_TS_LINE = re.compile(
    r'^\s*\{ id: (".*?"), label: (".*?"), sample: (".*?"), keywords: (\[.*?\]) \},\s*$')


def _ts_families():
    out = []
    with open(os.path.join(REPO, "src", "domain", "styleFamilies.ts"), encoding="utf-8") as f:
        for line in f:
            m = _TS_LINE.match(line)
            if m:
                i, l, s, k = (json.loads(g) for g in m.groups())
                out.append({"id": i, "label": l, "sample": s, "keywords": k})
    return out


def test_family_list_parity_with_ts():
    ts = _ts_families()
    assert len(ts) == 30
    assert list(sf.STYLE_FAMILIES) == ts


def test_keywords_unique_across_families():
    allk = [k.lower() for f in sf.STYLE_FAMILIES for k in f["keywords"]]
    assert len(allk) == len(set(allk))


def _npc(presentation="western ranch", age=22):
    return {"id": "npc:1", "age": age, "presentation": presentation,
            "physicalCharacteristics": {"hair": "short brown hair", "heightBuild": "tall and lean",
                                         "style": "x"}}


def _pc(**kw):
    base = {"heightBuild": "tall and lean", "skinTone": "tan", "hair": "short brown hair",
            "facialFeatures": "a square jaw", "distinguishingMark": "none notable",
            "ageLook": "youthful", "style": "a pearl-snap shirt and boots"}
    base.update(kw)
    return {"physicalCharacteristics": base}


def test_gray_hair_under_35():
    assert "gray-hair-young" in ca.look_problems(_pc(hair="silver-streaked undercut"), _npc(age=22))
    assert ca.look_problems(_pc(hair="dyed silver pixie"), _npc(age=22)) == []
    assert ca.look_problems(_pc(hair="salt-and-pepper"), _npc(age=44)) == []


def test_contradictory_build():
    assert "build-contradiction" in ca.look_problems(_pc(heightBuild="broad-shouldered, willowy limbs"), _npc())
    assert "build-contradiction" in ca.look_problems(_pc(heightBuild="tall and petite"), _npc())
    assert ca.look_problems(_pc(heightBuild="broad-shouldered and tall"), _npc()) == []


def test_wrong_family():
    bad = _pc(style="band tee, studded leather jacket")
    assert "style-wrong-family" in ca.look_problems(bad, _npc("western ranch"))
    # an own-family keyword alongside is accepted (the check needs none of their own)
    ok = _pc(style="a pearl-snap shirt, studded belt")
    assert "style-wrong-family" not in ca.look_problems(ok, _npc("western ranch"))


def test_wardrobe_rules():
    n = _npc()
    assert "wardrobe-shape" in ca.look_problems(_pc(wardrobe=["Def Leppard tee", "boots"]), n)
    assert "wardrobe-shape" in ca.look_problems(_pc(wardrobe=["tee with a big logo", "boots"]), n)
    assert "wardrobe-shape" in ca.look_problems(_pc(wardrobe=["only one item"]), n)
    assert "wardrobe-shape" in ca.look_problems(_pc(wardrobe=["a", "b", "c", "d"]), n)
    assert ca.look_problems(_pc(wardrobe=["pearl-snap shirt", "worn boots"]), n) == []


def test_oncamera_rules():
    n = _npc()
    assert ca.look_problems(_pc(onCamera="leans in; at the kitchen counter."), n) == []
    assert "oncamera-shape" in ca.look_problems(_pc(onCamera="leans in, no spot named."), n)
    assert "oncamera-scene" in ca.look_problems(_pc(onCamera="kitchen and also the backyard"), n)  # ORW-380: two spots
    assert "oncamera-scene" in ca.look_problems(_pc(onCamera="kitchen " + "x" * 300), n)           # ORW-380: over 240


def test_fallbacks_after_failed_retry():
    n = _npc()
    p = _pc(hair="silver hair", heightBuild="stocky and willowy", style="band tee, studded leather jacket",
            wardrobe=["Nike tee", "boots"], onCamera="no spot")
    probs = ca.look_problems(p, n)
    assert set(probs) == {"gray-hair-young", "build-contradiction", "style-wrong-family",
                          "wardrobe-shape", "oncamera-shape"}
    ca.apply_look_fallbacks(p, n, probs)
    pc = p["physicalCharacteristics"]
    assert pc["hair"] == "short brown hair" and pc["heightBuild"] == "tall and lean"
    assert pc["style"] == sf.family_for_label("western ranch")["sample"]
    assert "wardrobe" not in pc and "onCamera" not in pc
    assert ca.look_problems(p, n) == []


def test_parser_forwards_optional_fields():
    obj = {"biography": "A real person. " * 12, "physicalCharacteristics": {
        "heightBuild": "a", "skinTone": "b", "hair": "c", "facialFeatures": "d", "distinguishingMark": "e",
        "ageLook": "f", "style": "g", "wardrobe": ["one", "two"], "onCamera": "calm; kitchen."}}
    out = ca.parse_authored_profile(json.dumps(obj), "npc:1")
    pc = out["physicalCharacteristics"]
    assert pc["wardrobe"] == ["one", "two"] and pc["onCamera"] == "calm; kitchen."


def test_prompt_names_the_new_rules():
    for needle in ("wardrobe", "onCamera", "AGE COHERENCE", "BUILD COHERENCE", "style FAMILY"):
        assert needle.lower() in ca._SYSTEM.lower()


def test_retry_message_names_problem_not_text():
    msg = ca.look_retry_message(["gray-hair-young"])
    assert "gray-hair-young" in msg and msg.startswith(ca._STRICT_RETRY)


# ---- end to end through author_cast: one strict retry, then the fallbacks ----------------------------
from conftest import _run  # noqa: E402

_NPC = {"id": "npc:1", "name": "A", "age": 22, "presentation": "western ranch",
        "physicalCharacteristics": {"hair": "short brown hair", "heightBuild": "tall and lean", "style": "x",
                                     "distinguishingMark": "none notable"}}


def _profile(**kw):
    pc = {"heightBuild": "tall and lean", "skinTone": "tan", "hair": "short brown hair",
          "facialFeatures": "a square jaw", "distinguishingMark": "none notable", "ageLook": "youthful",
          "style": "a pearl-snap shirt and boots", "wardrobe": ["pearl-snap shirt", "worn boots"],
          "onCamera": "leans in with a half smile; at the kitchen counter."}
    pc.update(kw)
    return json.dumps({"biography": "A blunt rancher from Texas who came up the hard way. Friends call him loyal.",
                       "vocation": "rancher", "physicalCharacteristics": pc})


def test_retry_fixes_the_look_and_the_fixed_profile_is_written():
    replies = [_profile(hair="silver-streaked undercut"), _profile()]
    sent, writes = [], []

    async def llm_fn(messages):
        sent.append(messages)
        return replies[len(sent) - 1]

    async def write_fn(p):
        writes.append(p)
        return {"accepted": True}

    assert _run(ca.author_cast([dict(_NPC)], llm_fn, write_fn)) == 1
    assert len(sent) == 2 and "gray-hair-young" in sent[1][-1]["content"]
    assert writes[0]["physicalCharacteristics"]["hair"] == "short brown hair"
    assert writes[0]["physicalCharacteristics"]["wardrobe"] == ["pearl-snap shirt", "worn boots"]


def test_failed_retry_applies_fallbacks_and_logs_no_text():
    bad = _profile(hair="silver hair", wardrobe=["Def Leppard tee", "boots"], onCamera="nowhere named")
    writes, lines = [], []

    async def llm_fn(messages):
        return bad

    async def write_fn(p):
        writes.append(p)
        return {"accepted": True}

    lid = ca.logger.add(lambda m: lines.append(str(m)), level="DEBUG") if hasattr(ca.logger, "add") else None
    try:
        assert _run(ca.author_cast([dict(_NPC)], llm_fn, write_fn)) == 1
    finally:
        if lid is not None:
            ca.logger.remove(lid)
    pc = writes[0]["physicalCharacteristics"]
    assert pc["hair"] == "short brown hair"
    assert "wardrobe" not in pc and "onCamera" not in pc
    joined = "".join(lines)
    assert "Def Leppard" not in joined and "silver hair" not in joined
    if lid is not None:
        assert "npc:1" in joined and "look-fallback" in joined

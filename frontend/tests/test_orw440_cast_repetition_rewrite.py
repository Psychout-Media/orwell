"""Cast repetition (rep-ident-open, rep-oncamera-end) triggers ONE bounded re-write of the repeated field on the LATER card.
Stub writers only; no model call. Opaque tokens, no real names."""
import asyncio
import copy

import pytest

from src import orwell_cast_gate as gate

LOOK = {"heightBuild": "average build", "skinTone": "fair", "hair": "short brown hair", "facialFeatures": "square jaw",
        "distinguishingMark": "none notable", "ageLook": "looks his age", "style": "plain",
        "wardrobe": ["grey crew tee", "dark jeans"], "photoHair": "brushed back", "onCamera": "arms folded, watching the room first"}
VOICE = {"register": "plain", "rhythm": "even", "energy": "calm", "directness": "blunt", "humor": "dry",
         "stressTell": "goes quiet", "signature": "says well then", "lexicon": ["well then"]}
BIO = "{n} grew up in Macon and welds boats. He keeps lists of everything and never sleeps well on a Sunday night."


def _npc(i, first, **kw):
    d = {"id": f"npc:{i}", "name": f"{first} Surnamea", "genderPresentation": "man", "age": 30, "vocation": "welder",
         "hometown": "Macon, Georgia"}
    d.update(kw)
    return d


def _profile(first, ident, cam=None):
    look = dict(LOOK)
    if cam:
        look["onCamera"] = cam
    return {"biography": BIO.format(n=first), "vocation": "welder", "identityConcept": ident,
            "physicalCharacteristics": look, "voice": dict(VOICE)}


def _go(c):
    return asyncio.new_event_loop().run_until_complete(c)


def _two(second_npc=None, rewrite=None, cam_b=None, ident_b="A thirty-year-old welder who reads a room before speaking."):
    """Gate card A (accepted), then card B that repeats A's opening; return (g, profile_b, calls)."""
    g = gate.SeasonGate("t")
    a, b = _npc(1, "Namea"), second_npc or _npc(2, "Nameb")
    cast = [a, b]
    _go(gate.run_gate(g, _profile("Namea", "A thirty-year-old welder who fixes boats and hums."), a, cast, None))
    pb = _profile("Nameb", ident_b, cam_b)
    calls = []

    async def rw(npc, codes, message=None):
        calls.append((codes, message))
        return rewrite(copy.deepcopy(pb)) if rewrite else None
    got, _ = _go(gate.run_gate(g, pb, b, cast, rw))
    return g, got, calls


def test_a_repeated_identity_opening_is_rewritten_on_the_later_card_only():
    def fix(p):
        p["identityConcept"] = "Nameb wears the quiet like a coat and reads a room before speaking."
        p["name"] = "Changed Name"  # anything but the two repeated fields must be ignored
        p["biography"] = "Totally different story."
        p["physicalCharacteristics"]["hair"] = "bald"
        return p
    g, got, calls = _two(rewrite=fix)
    assert len(calls) == 1 and "thirty" in calls[0][1] and "identityConcept" in calls[0][1]
    assert got["identityConcept"].startswith("Nameb wears")
    assert "name" not in got and got["biography"].startswith("Nameb grew up") and got["physicalCharacteristics"]["hair"] == "short brown hair"
    assert g.rep_rewritten == 1 and g.rep_fixed == 1 and "rep-ident-open" not in g.codes


def test_a_repeated_oncamera_ending_is_rewritten_and_only_that_line_changes():
    def fix(p):
        p["physicalCharacteristics"]["onCamera"] = "He leans on the counter in the kitchen, laughing at nothing, the one who never sleeps."
        p["identityConcept"] = "Something else entirely."
        return p
    cam = "arms folded, watching the room first"
    g = gate.SeasonGate("t")
    a, b = _npc(1, "Namea"), _npc(2, "Nameb")
    cast = [a, b]
    _go(gate.run_gate(g, _profile("Namea", "A welder who fixes boats and hums.", cam), a, cast, None))
    pb = _profile("Nameb", "Nameb is a welder who keeps the lights on.", cam)

    async def rw(npc, codes, message=None):
        assert "onCamera" in message and "identityConcept" not in message
        return fix(copy.deepcopy(pb))
    got, _ = _go(gate.run_gate(g, pb, b, cast, rw))
    assert got["physicalCharacteristics"]["onCamera"].startswith("He leans")
    assert got["identityConcept"] == "Nameb is a welder who keeps the lights on."
    assert g.rep_fixed == 1


def test_a_rewrite_that_still_repeats_ships_the_original_after_one_call():
    g, got, calls = _two(rewrite=lambda p: p)  # unchanged
    assert len(calls) == 1 and got["identityConcept"].startswith("A thirty-year-old welder who reads")
    assert g.codes.get("rep-ident-open") == 1 and g.rep_fixed == 0
    g, got, calls = _two(rewrite=lambda p: {**p, "identityConcept": "A thirty-year-old welder who is different."})
    assert len(calls) == 1 and got["identityConcept"].startswith("A thirty-year-old welder who reads")


def test_a_writer_error_or_nothing_leaves_the_card_as_it_is():
    b = _npc(2, "Nameb")
    g = gate.SeasonGate("t")
    a = _npc(1, "Namea")
    _go(gate.run_gate(g, _profile("Namea", "A thirty-year-old welder who fixes boats."), a, [a, b], None))
    pb = _profile("Nameb", "A thirty-year-old welder who reads a room.")

    async def boom(npc, codes, message=None):
        raise RuntimeError("provider down")
    got, _ = _go(gate.run_gate(g, pb, b, [a, b], boom))
    assert got is not None and got["identityConcept"].startswith("A thirty-year-old welder who reads")
    _, got2, calls = _two(rewrite=None)
    assert len(calls) == 1 and got2 is not None


def test_an_introduced_card_is_never_rewritten():
    for flag in ("met", "introduced"):
        g, got, calls = _two(second_npc=_npc(2, "Nameb", **{flag: True}), rewrite=lambda p: {**p, "identityConcept": "Different."})
        assert calls == [] and got["identityConcept"].startswith("A thirty-year-old")


def test_the_first_card_to_use_a_phrasing_keeps_it_and_no_card_is_rewritten_without_a_repeat():
    g = gate.SeasonGate("t")
    a = _npc(1, "Namea")
    calls = []

    async def rw(npc, codes, message=None):
        calls.append(1)
        return None
    _go(gate.run_gate(g, _profile("Namea", "A thirty-year-old welder who fixes boats."), a, [a], rw))
    assert calls == [] and g.rep_rewritten == 0


def test_no_writer_means_no_repetition_rewrite():
    g = gate.SeasonGate("t")
    a, b = _npc(1, "Namea"), _npc(2, "Nameb")
    _go(gate.run_gate(g, _profile("Namea", "A thirty-year-old welder who fixes boats."), a, [a, b], None))
    got, _ = _go(gate.run_gate(g, _profile("Nameb", "A thirty-year-old welder who reads."), b, [a, b], None))
    assert got is not None and g.codes.get("rep-ident-open") == 1


# ---- review: a rewritten line goes through the same checks as a first-pass one ---------------------------------
def _woman_pair(cam_fix=None, ident_fix=None):
    g = gate.SeasonGate("t")
    a = _npc(1, "Namea", genderPresentation="woman")
    b = _npc(2, "Nameb", genderPresentation="woman", age=25)
    cast = [a, b]
    cam = "She sits in the kitchen, arms folded, the one who misses nothing."
    pa = _profile("Namea", "A welder who fixes boats and hums.", cam)
    pa["biography"] = pa["biography"].replace("He ", "She ")
    _go(gate.run_gate(g, pa, a, cast, None))
    pb = _profile("Nameb", "Nameb is a welder who keeps the lights on.", cam)
    pb["biography"] = pb["biography"].replace("He ", "She ")
    pb["physicalCharacteristics"]["hair"] = "espresso brown hair"
    pb["physicalCharacteristics"]["photoHair"] = "espresso brown hair brushed back"
    before = copy.deepcopy(pb)

    async def rw(npc, codes, message=None):
        p = copy.deepcopy(pb)
        if cam_fix:
            p["physicalCharacteristics"]["onCamera"] = cam_fix
        if ident_fix:
            p["identityConcept"] = ident_fix
        return p
    got, _ = _go(gate.run_gate(g, pb, b, cast, rw))
    return got, before, g


@pytest.mark.parametrize("bad", [
    "He stands in the doorway, his arms folded, the one who reads the room first.",
    "She stands in the kitchen in round gold glasses and a nose ring, the one who reads the room first.",
    "She stands in the kitchen with bright pink hair, the one who reads the room first.",
    "She stands in the doorway, the one who reads the room first.",
])
def test_a_rewritten_oncamera_line_that_fails_the_look_checks_is_not_stored(bad):
    got, before, g = _woman_pair(cam_fix=bad)
    assert got["physicalCharacteristics"]["onCamera"] == before["physicalCharacteristics"]["onCamera"]
    assert g.rep_fixed == 0


def test_a_good_rewritten_oncamera_line_is_stored():
    got, before, g = _woman_pair(cam_fix="She leans on the counter in the kitchen, brown hair loose, the one who reads the room first.")
    assert got["physicalCharacteristics"]["onCamera"].startswith("She leans") and g.rep_fixed >= 1


def test_a_rewritten_identity_over_the_first_pass_length_is_not_stored():
    got, before, g = _woman_pair(ident_fix="Nameb " + "keeps the lights on and " * 30 + "reads a room.")
    assert got["identityConcept"] == before["identityConcept"]

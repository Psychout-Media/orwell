"""ORW-431: the one gate at the end of cast authoring (stub writers only, no model call anywhere).

Every live example from 2026-11-15 goes through author_cast with a writer that returns the stale or broken text: the
card written is consistent, or the card is left not authored with the reason codes. Codes only; no card text is logged.
"""
import asyncio
import json
import logging
import os
import random

import pytest

from src import orwell_cast_authoring as ca
from src import orwell_cast_gate as gate

CARDS = json.load(open(os.path.join(os.path.dirname(__file__), "fixtures", "orw430_live_cards.json")))
LOOK = {"heightBuild": "average build", "skinTone": "fair", "hair": "short brown hair", "facialFeatures": "square jaw",
        "distinguishingMark": "a small scar on the chin", "ageLook": "looks his age", "style": "plain",
        "wardrobe": ["grey crew tee", "dark jeans"], "photoHair": "brushed back", "onCamera": "arms folded"}
VOICE = {"register": "plain", "rhythm": "even", "energy": "calm", "directness": "blunt", "humor": "dry",
         "stressTell": "goes quiet", "signature": "says well then", "lexicon": ["well then"]}
FILLER = " Weekends mean long drives to see family, a notebook full of lists, and a standing bet with the neighbours."


@pytest.fixture(autouse=True)
def gate_on(monkeypatch):
    monkeypatch.setenv("ORWELL_CAST_GATE", "1")
    ca._ATTEMPTS.clear() if hasattr(ca, "_ATTEMPTS") else None


def npc_of(hid, name, gender, age, ident=None):
    ident = ident or f"A quiet organiser named {name.split()[0]} who reads a room before speaking up."
    return {"id": hid, "name": name, "genderPresentation": gender, "age": age, "vocation": "welder", "hometown": "Macon, Georgia",
            "identityConcept": ident, "physicalCharacteristics": dict(LOOK), "voice": dict(VOICE)}


def profile_json(bio, **extra):
    d = {"biography": bio, "vocation": "welder", "physicalCharacteristics": {k: v for k, v in LOOK.items()}, "voice": VOICE}
    d.update(extra)
    return json.dumps(d)


async def run(cast, reply_for, caplog=None):
    written = {}
    calls = {"n": 0}

    async def llm(messages):
        calls["n"] += 1
        hid = next(n["id"] for n in cast if f'"name": "{n["name"]}"' in messages[1]["content"])
        return reply_for(hid, calls["n"])

    async def write(profile):
        written[profile["houseguestId"]] = profile
        return {"accepted": True}

    n = await ca.author_cast(cast, llm, write, user="t431")
    return n, written, calls["n"]


def _go(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# ---- every live example, stub writer returns the broken text ---------------------------------------------
def test_samir_nia_biography_is_written_about_samir():
    cast = [npc_of("npc:5", "Samir Nesbitt", "man", 23)]
    n, w, _ = _go(run(cast, lambda h, i: profile_json(CARDS["Samir Nesbitt"]["biography"])))
    assert n == 1 and "Nia" not in w["npc:5"]["biography"] and w["npc:5"]["biography"].startswith("Samir")


@pytest.mark.parametrize("name,gender,age,bad,needle", [
    ("Gabe Cottrell", "man", 41, "Gabe runs a literacy nonprofit in Durbin. She's running the house with a clipboard and she knows it.", "She's"),
    ("Imani Mason", "woman", 33, "Imani is a firefighter in Nashua. Everyone admires his own brilliance and his steady hands.", "his own"),
    ("Thomas Sizemore", "man", 25, "Thomas is 24 years old and climbs trees for a living in Ellijay. He keeps a notebook of every tell.", "24"),
    ("Dina Park", "woman", 49, "Dina runs a bakery in Ellijay. She is a 52-year-old who keeps a notebook of every tell around the house.", "52"),
    ("Lena Ford", "woman", 30, "Lena is a gap-toothed nurse from Macon. She keeps a notebook of every tell around the house.", "gap-toothed"),
    ("Rae Hunt", "woman", 30, "Rae wants to win Big Brother this year. She keeps a notebook of every tell around the house.", "Big Brother"),
])
def test_live_inconsistencies_are_mended_before_write(name, gender, age, bad, needle):
    cast = [npc_of("npc:1", name, gender, age)]
    cast[0]["physicalCharacteristics"]["facialFeatures"] = "square jaw"
    n, w, _ = _go(run(cast, lambda h, i: profile_json(bad + FILLER)))
    assert n == 1
    assert needle not in w["npc:1"]["biography"]
    assert gate.card_codes(w["npc:1"], cast[0], cast) == []


def test_briana_empty_biography_is_left_not_authored_with_codes(caplog):
    cast = [npc_of("npc:15", "Briana Pickett", "woman", 22)]
    caplog.set_level(logging.INFO)
    n, w, calls = _go(run(cast, lambda h, i: profile_json("")))
    assert n == 0 and w == {}
    assert calls <= 1 + 3 + gate.GATE_REWRITE_BOUND  # first call, its own retries, and the bounded gate re-writes
    assert any("npc:15" in r.message and "story-no-biography" in r.message for r in caplog.records)


def test_a_rewrite_that_comes_back_clean_is_accepted():
    cast = [npc_of("npc:1", "Gabe Cottrell", "man", 41)]
    bad = profile_json("")
    good = profile_json("Gabe runs a literacy nonprofit in Durbin. He hauls book crates to one-room schools every spring." + FILLER)
    n, w, calls = _go(run(cast, lambda h, i: bad if i == 1 else good))
    assert n == 1 and w["npc:1"]["biography"].startswith("Gabe runs")


# ---- 40 seeded casts, a writer that ALWAYS uses a wrong given name, pronoun and age ----------------------
def test_forty_seeded_casts_never_accept_an_inconsistent_card():
    accepted = 0
    for seed in range(40):
        rng = random.Random(seed)
        firsts = rng.sample(["Ava", "Bo", "Cal", "Dee", "Eli", "Fay", "Gus", "Hal", "Ivy", "Jon", "Kai", "Lou"], 4)
        cast = []
        for i, f in enumerate(firsts):
            g = rng.choice(["man", "woman"])
            cast.append(npc_of(f"npc:{i}", f"{f} Smith{i}", g, rng.randint(20, 60)))

        def reply(h, i, cast=cast):
            npc = next(c for c in cast if c["id"] == h)
            wrong_pron = "She" if npc["genderPresentation"] == "man" else "He"
            return profile_json(f"Zelda Quill is {npc['age'] + 3} and runs a shop in Ellijay. {wrong_pron} keeps a notebook "
                                f"of every tell and {wrong_pron.lower()} never forgets one." + FILLER)
        n, w, _ = _go(run(cast, reply))
        for hid, prof in w.items():
            npc = next(c for c in cast if c["id"] == hid)
            assert not [c for c in gate.card_codes(prof, npc, cast) if gate.is_blocking(c)], (seed, hid)
            accepted += 1
        assert n == len(w)
    assert accepted > 0


# ---- the season line ----------------------------------------------------------------------------------------
def test_season_line_counts_for_a_known_cast(caplog):
    cast = [npc_of("npc:1", "Samir Nesbitt", "man", 23), npc_of("npc:2", "Thomas Sizemore", "man", 25),
            npc_of("npc:3", "Briana Pickett", "woman", 22)]

    def reply(h, i):
        if h == "npc:1":
            return profile_json(CARDS["Samir Nesbitt"]["biography"])           # repaired
        if h == "npc:2":
            return profile_json(CARDS["Thomas Sizemore"]["biography"])         # clean
        return profile_json("")                                                # fails
    caplog.set_level(logging.INFO)
    _go(run(cast, reply))
    line = [r.message for r in caplog.records if "[cast-gate] season line" in r.message]
    assert len(line) == 1
    assert "checked=3 repaired=1 rewritten=1 failing=1" in line[0]
    assert "story-name=1" in line[0] and "story-no-biography=" in line[0]
    assert "Samir" not in line[0] and "Nia" not in line[0]  # codes only


def test_cross_cast_duplicate_biography_is_refused():
    cast = [npc_of("npc:1", "Ava Smith", "woman", 30), npc_of("npc:2", "Bea Jones", "woman", 31)]
    same = "A shop owner from the river towns who learned to fix engines early. She runs a shop in Macon now." + FILLER
    n, w, _ = _go(run(cast, lambda h, i: profile_json(same)))
    assert n <= 1 and len(w) == n


# ---- the coordinator's additions: look fields, background vs biography, nonbinary, cast repetition ------
def test_giovanni_missing_look_fields_is_accepted_non_blocking_and_asks_the_backfill():
    npc = npc_of("npc:7", "Giovanni Calloway", "man", 36)
    for k in ("wardrobe", "onCamera", "photoHair"):
        npc["physicalCharacteristics"].pop(k)
    prof = {"biography": "Giovanni runs a body shop in Utica. He fixes every dent himself and trusts no estimate." + FILLER}
    codes = gate.card_codes(prof, npc, [npc])
    assert {"look-missing-wardrobe", "look-missing-onCamera", "look-missing-photoHair"} <= set(codes)
    assert not any(gate.is_blocking(c) for c in codes)
    n, w, _ = _go(run([npc], lambda h, i: json.dumps({"biography": prof["biography"], "voice": VOICE})))
    assert n == 1 and "npc:7" in w
    # readiness (the season start) does not wait on it; the backfill does pick it up
    card = {"id": "npc:7", "authored": True, "biography": prof["biography"], "identityConcept": npc["identityConcept"],
            "physicalCharacteristics": npc["physicalCharacteristics"]}
    assert ca.unauthored_ids("u", [card]) == [] and ca.unauthored_ids("u", [card], include_look=True) == ["npc:7"]


def test_background_and_biography_with_different_years_are_flagged():
    npc = npc_of("npc:8", "Mariana Whitlock", "woman", 38)
    npc["background"] = "twenty years inside the county courthouse"
    prof = {"biography": "Mariana has spent twelve years as a court clerk in Utica. She knows every judge by their coffee order." + FILLER}
    assert "background-years" in gate.card_codes(prof, npc, [npc])
    prof["biography"] = prof["biography"].replace("twelve years", "twenty years")
    assert "background-years" not in gate.card_codes(prof, npc, [npc])


def test_the_writer_is_shown_the_earlier_text_as_fact_to_keep():
    npc = npc_of("npc:8", "Mariana Whitlock", "woman", 38)
    npc["background"] = "twenty years inside the county courthouse"
    user = ca.build_authoring_messages(npc)[1]["content"]
    assert "twenty years inside the county courthouse" in user and "FACTS about Mariana Whitlock" in user


def test_nonbinary_houseguest_is_held_to_they_them():
    npc = npc_of("npc:9", "Monique Tarver", "nonbinary", 31)
    prof = {"biography": "Monique keeps the whole spreadsheet in her head. Nobody has ever seen her use a calculator and she likes it that way." + FILLER}
    assert "story-pronoun" in gate.card_codes(prof, npc, [npc])
    gate.mend(prof, npc)
    assert " her " not in prof["biography"] and "they" in prof["biography"].lower()
    assert "story-pronoun" not in gate.card_codes(prof, npc, [npc])


def test_cast_repetition_is_reported_and_the_next_writer_is_told_what_is_taken(caplog):
    g = gate.SeasonGate("t")
    cast = [npc_of(f"npc:{i}", f"{f} Smith", "man", 30) for i, f in enumerate(["Ava", "Bo", "Cal"])]
    for n in cast:
        n["physicalCharacteristics"].update(onCamera="eyes down, the one who watches", distinguishingMark="a pale knuckle scar")
        n["identityConcept"] = f"A restless {n['name']} who is ahead of the game."
        g.accept(n["id"], {}, n, cast)
    assert g.codes == {"rep-oncamera-end": 2, "rep-ident-open": 2, "rep-mark": 2}
    t = g.taken_phrases("npc:9")
    user = ca.build_authoring_messages(cast[0], taken={"phrases": t})[1]["content"]
    assert "every mark is unique" in user and "pale knuckle scar" in user


# ---- A: the writer owns identityConcept; genesis's stale one is replaced, never shown --------------------
def test_writer_identity_concept_replaces_genesis_stale_one():
    npc = npc_of("npc:5", "Samir Nesbitt", "man", 23, ident="Nia is a soft-spoken apprentice who reads a room and floats through every alliance.")
    cast = [npc]
    n, w, _ = _go(run(cast, lambda h, i: profile_json(
        CARDS["Samir Nesbitt"]["biography"], identityConcept="A soft-spoken funeral apprentice who reads a room before he speaks.")))
    assert n == 1 and w["npc:5"]["identityConcept"].startswith("A soft-spoken funeral apprentice")
    assert "Nia" not in w["npc:5"]["biography"]


def test_stale_genesis_identity_without_a_writer_one_is_mended_by_name():
    npc = npc_of("npc:5", "Samir Nesbitt", "man", 23, ident="Nia is a soft-spoken apprentice. She reads a room before anyone else does.")
    prof = {"biography": CARDS["Thomas Sizemore"]["biography"].replace("Thomas", "Samir")}
    assert any(c.startswith("identity-") for c in gate.card_codes(prof, npc, [npc]))
    n, w, _ = _go(run([npc], lambda h, i: profile_json(prof["biography"])))
    if n:
        assert "Nia" not in w["npc:5"].get("identityConcept", "Samir") and not any(
            c.startswith("identity-") for c in gate.card_codes(w["npc:5"], npc, [npc]))


# ---- the worst case: one card never gets onCamera and never gets a biography --------------------------------
def test_worst_case_a_stub_that_never_returns_oncamera_or_a_biography_for_one_card(caplog):
    cast = [npc_of(f"npc:{i}", f"{f} Smith{i}", "woman", 30) for i, f in enumerate(["Ava", "Bea", "Cy"])]
    for n in cast:
        n["physicalCharacteristics"].pop("onCamera")
    bad = "npc:1"

    def reply(h, i):
        if h == bad:
            return profile_json("")  # never a biography
        return profile_json(f"{[c for c in cast if c['id'] == h][0]['name'].split()[0]} runs a shop in Macon. She fixes engines every day." + FILLER)
    caplog.set_level(logging.DEBUG)
    n, w, calls = _go(run(cast, reply))
    assert n == 2 and set(w) == {"npc:0", "npc:2"}                   # the other cards are accepted despite no onCamera
    assert calls <= 3 + 3 + gate.GATE_REWRITE_BOUND + 4              # bounded: no loop
    assert any("npc:1" in r.message and "tier=blocking" in r.message for r in caplog.records)
    assert any("npc:0" in r.message and "tier=non-blocking" in r.message and "look-missing-onCamera" in r.message for r in caplog.records)
    # what the wait is: the unauthored card is the only thing readiness sees, never the look code
    cards = [{"id": c["id"], "authored": c["id"] != bad, "biography": "x" * 90, "identityConcept": "y" * 40,
              "physicalCharacteristics": c["physicalCharacteristics"]} for c in cast]
    assert ca.unauthored_ids("u", cards) == [bad]


def test_the_wait_caps_are_the_existing_ones():
    assert ca._HOUSE_READY_INLINE_S == 10.0 and ca._HOUSE_READY_WATCH_TIMEOUT_S == 1800.0 and ca._ATTEMPT_CAP == 6


# ---- own-job role words (Lydia) ------------------------------------------------------------------------------
LYDIA = "A small-town strength coach who treats every competition as a chess match he has already won in his head."


def test_own_job_role_noun_does_not_make_the_sentence_about_someone_else():
    npc = npc_of("npc:4", "Lydia Sutter", "woman", 34)
    npc["vocation"] = "strength coach"
    assert ca.pronoun_conflict_sentences(LYDIA, npc) == [0]
    npc2 = {**npc, "vocation": "gym owner"}
    assert ca.pronoun_conflict_sentences(LYDIA, npc2) == [0]          # "A ... coach who" describes her, whatever the job field says
    assert ca.pronoun_conflict_sentences("Her coach says he has already won in his head.", npc2) == []  # a real second person stays
    fixed = ca.repair_story_text(LYDIA, {}, npc)
    assert fixed.endswith("she has already won in her head.")
    prof = {"biography": LYDIA + " She lives in Macon and runs a gym." + FILLER}
    assert "story-pronoun" in ca.story_problems(prof, npc)
    ident_card = {**npc, "identityConcept": LYDIA}
    assert "identity-pronoun" in ca.card_consistency({"biography": prof["biography"]}, ident_card)
    p2 = {"biography": "Lydia runs a gym in Macon. She trains every client herself." + FILLER}
    gate.mend(p2, ident_card)
    assert p2["identityConcept"].endswith("she has already won in her head.")


# ---- a card whose authoring call failed: picked up again, the final card has the name ----------------------
def test_a_call_that_fails_for_one_card_is_listed_for_backfill_and_the_reauthored_card_has_the_name():
    cast = [npc_of(f"npc:{i}", f"{f} Smith{i}", "woman", 30) for i, f in enumerate(["Ava", "Bea", "Cy"])]
    for c in cast:
        c["biography"] = "Runs compliance for a regional credit union but spends lunch hours at the climbing gym and the library."
    failing = {"on": True}

    async def run1():
        written = {}

        async def llm(messages):
            hid = next(n["id"] for n in cast if f'"name": "{n["name"]}"' in messages[1]["content"])
            if failing["on"] and hid == "npc:1":
                raise RuntimeError("authoring stream exceeded its 30.0s wall-clock ceiling")
            return profile_json(f"{[c for c in cast if c['id'] == hid][0]['name'].split()[0]} runs a shop in Macon. She fixes engines every day." + FILLER)

        async def write(profile):
            written[profile["houseguestId"]] = profile
            return {"accepted": True}
        n = await ca.author_cast(cast, llm, write, user="t431b")
        return n, written, llm, write
    n, w, llm, write = _go(run1())
    assert n == 2 and "npc:1" not in w
    cards = [{"id": c["id"], "authored": c["id"] in w, "biography": c["biography"], "identityConcept": c["identityConcept"],
              "physicalCharacteristics": c["physicalCharacteristics"]} for c in cast]
    assert ca.unauthored_ids("u", cards) == ["npc:1"]                      # the failed card is in the backfill's list (and the readiness wait)
    assert gate.card_codes({}, cast[1], cast).count("bio-no-own-name") == 1  # the floor biography reads as a fragment
    failing["on"] = False
    ca._ATTEMPTS.clear() if hasattr(ca, "_ATTEMPTS") else None
    n2 = _go(ca.author_cast([cast[1]], llm, write, user="t431b2"))        # what the backfill does
    assert n2 == 1 and w["npc:1"]["biography"].startswith("Bea")
    assert "bio-no-own-name" not in gate.card_codes(w["npc:1"], cast[1], cast)


def test_none_notable_is_not_a_repeated_mark():
    g = gate.SeasonGate("t")
    cast = [npc_of(f"npc:{i}", f"{f} Smith", "man", 30) for i, f in enumerate(["Ava", "Bo"])]
    for n in cast:
        n["physicalCharacteristics"]["distinguishingMark"] = "none notable beyond a faint scar"
        g.accept(n["id"], {}, n, cast)
    assert "rep-mark" not in g.codes

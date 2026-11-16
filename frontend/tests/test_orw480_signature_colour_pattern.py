"""ORW-480: the memorable look signature (authored, one per person, no two share a category), the colour spread (no family on more than a
fifth of the cast) and the pattern floor (at least a third wear a pattern, a plain graphic or visible wear). Roles only, no real names."""
import asyncio

from src import orwell_cast_authoring as A
from src import orwell_cast_gate as G
from src import orwell_cast_realism as R


def _card(i, wardrobe, sig=None, job="line cook"):
    phys = {"wardrobe": wardrobe}
    if sig is not None:
        phys["lookSignature"] = sig
    return {"id": f"npc:{i}", "name": f"Person {i}", "vocation": job, "age": 30, "physicalCharacteristics": phys}


def test_the_signature_kinds_tag_what_a_friend_would_say():
    tag = lambda s: R.tag_card({"physicalCharacteristics": {"lookSignature": s}}).get("signature")
    assert tag("a long single braid") == ["hair"]
    assert tag("silver crop and big hoops") == ["hair"]  # one thing: the first category word
    assert tag("a shell necklace she never takes off") == ["jewellery"]
    assert tag("wire glasses") == ["glasses"]
    assert tag("a faded denim jacket") == ["outerwear"]
    assert tag("") is None


def test_a_later_card_with_a_full_signature_category_is_asked_for_a_different_one():
    g = G.SeasonGate("u"); g.n = 15; g.want_signature = True
    a1, a2, b = (_card(1, ["grey sweatshirt", "jeans"], "a long single braid"), _card(2, ["grey polo", "chinos"], "a bleached buzz cut"),
                 _card(3, ["rust flannel", "canvas pants"], "a braided ponytail"))
    cast = [a1, a2, b]
    g.accept("npc:1", {}, a1, cast)
    assert "signature" not in g.repeats("npc:3", {}, b, cast).get("realism-wardrobe", {})  # two of a kind are allowed
    g.accept("npc:2", {}, a2, cast)
    assert g.repeats("npc:3", {}, b, cast)["realism-wardrobe"]["signature"] == ["hair"]
    taken = g.taken_phrases("npc:3")
    assert taken["signatures"] == ["hair"] and "hair" not in taken["signatures_free"] and "jewellery" in taken["signatures_free"]
    assert "hair" in G.repetition_message(g.repeats("npc:3", {}, b, cast), taken) and "still free" in G.repetition_message(g.repeats("npc:3", {}, b, cast), taken)


def test_a_missing_signature_is_asked_only_in_a_real_cast_run():
    c = _card(1, ["grey sweatshirt", "jeans"])
    g = G.SeasonGate("u"); g.n = 15
    assert "signature" not in g.repeats("npc:1", {}, c, [c]).get("realism-wardrobe", {})
    g.want_signature = True
    assert g.repeats("npc:1", {}, c, [c])["realism-wardrobe"]["signature"] == ["missing"]


def test_no_colour_family_on_more_than_three_of_fifteen_and_five_wear_a_pattern():
    assert R.cap_for("colour", "navy-blue", 15) == 3
    assert R.cap_for("pattern", "plain", 15) == 10  # so at least five of fifteen are patterned
    cast = [_card(i, ["navy fleece pullover", "dark jeans"]) for i in range(1, 16)]
    g = G.SeasonGate("u"); g.n = 15
    asked = []
    for c in cast:
        off = g.repeats(c["id"], {}, c, cast).get("realism-wardrobe", {})
        asked.append(set(off))
        g.accept(c["id"], {}, c, cast)
    assert all("colour" not in a for a in asked[:3]) and all("colour" in a for a in asked[3:])
    assert all("pattern" not in a for a in asked[:10]) and all("pattern" in a for a in asked[10:])
    pat = R.tag_card(_card(1, ["striped button-up", "jeans"]))
    assert pat["pattern"] == ["patterned"]
    assert R.tag_card(_card(1, ["faded band-free grey tee", "jeans"]))["pattern"] == ["patterned"]


def test_signature_shape_is_a_look_problem_and_the_fallback_drops_only_the_signature():
    npc = {"id": "npc:1", "genderPresentation": "woman", "age": 30}
    for bad in ("x" * 91, "a tattoo of a rose", "a shirt with words on it"):
        prof = {"physicalCharacteristics": {"wardrobe": ["grey sweatshirt", "jeans"], "lookSignature": bad}}
        probs = A.look_problems(prof, npc)
        assert "signature-shape" in probs, bad
        A.apply_look_fallbacks(prof, npc, probs)
        assert "lookSignature" not in prof["physicalCharacteristics"] and prof["physicalCharacteristics"]["wardrobe"]
    good = {"physicalCharacteristics": {"wardrobe": ["grey sweatshirt", "jeans"], "lookSignature": "a long single braid"}}
    assert A.look_problems(good, npc) == []


def test_the_writer_prompt_states_the_signature_rule_and_the_taken_lists_without_an_example_list():
    system = A.build_authoring_messages({"id": "npc:1", "vocation": "welder"})[0]["content"]
    assert "lookSignature" in system and "describe them to a friend" in system and "nobody else in the cast has" in system
    msgs = A.build_authoring_messages({"id": "npc:1", "vocation": "welder"}, taken={"phrases": {"signatures": ["hair"], "colours": ["navy-blue"]}})
    user = msgs[1]["content"]
    assert "lookSignature categories already taken" in user and "hair" in user and "navy-blue" in user


LOOK = {"heightBuild": "average build", "skinTone": "fair", "hair": "short brown hair", "facialFeatures": "square jaw",
        "distinguishingMark": "none notable", "ageLook": "looks his age", "style": "plain",
        "wardrobe": ["grey crew tee", "dark jeans"], "photoHair": "brushed back", "onCamera": "arms folded, watching the room first"}
VOICE = {"register": "plain", "rhythm": "even", "energy": "calm", "directness": "blunt", "humor": "dry",
         "stressTell": "goes quiet", "signature": "says well then", "lexicon": ["well then"]}


def _profile(first, ident, sig=None, wardrobe=None):
    look = dict(LOOK)
    if sig:
        look["lookSignature"] = sig
    if wardrobe:
        look["wardrobe"] = wardrobe
    return {"biography": f"{first} grew up in Macon and welds boats. He keeps lists of everything and never sleeps well on a Sunday night.",
            "vocation": "welder", "identityConcept": ident, "physicalCharacteristics": look, "voice": dict(VOICE)}


def _npc(i, first):
    return {"id": f"npc:{i}", "name": f"{first} Surnamea", "genderPresentation": "man", "age": 30, "vocation": "welder", "hometown": "Macon, Georgia"}


def _run(second_sig, rewrite, second_wardrobe=None):
    g = G.SeasonGate("t"); g.want_signature = True
    a, b = _npc(1, "Namea"), _npc(2, "Nameb")
    cast = [a, b]
    loop = asyncio.new_event_loop()
    loop.run_until_complete(G.run_gate(g, _profile("Namea", "A welder who fixes boats and hums.", "a long single braid", ["navy hoodie", "dark jeans"]), a, cast, None))
    g.registry["npc:0"] = {"tags": {"signature": ["hair"]}}  # a second hair signature: the category is full

    async def rw(npc, codes, message=None):
        return rewrite

    got, _ = loop.run_until_complete(G.run_gate(g, _profile("Nameb", "A man who reads a room before speaking.", second_sig, second_wardrobe or ["rust flannel", "dark jeans"]), b, cast, rw))
    return got["physicalCharacteristics"]


def test_the_rewrite_carries_the_signature_with_the_wardrobe():
    pc = _run("a braided ponytail", {"physicalCharacteristics": {"wardrobe": ["mustard corduroy overshirt", "faded black jeans"], "lookSignature": "a shell necklace"}})
    assert pc["wardrobe"][0].startswith("mustard") and pc["lookSignature"] == "a shell necklace"


def test_a_writer_that_leaves_the_signature_out_still_ships_the_clothes_it_fixed():
    pc = _run(None, {"physicalCharacteristics": {"wardrobe": ["mustard corduroy overshirt", "faded black jeans"]}}, ["silk blouse", "cashmere cardigan", "tailored trousers"])
    assert pc["wardrobe"][0].startswith("mustard") and "lookSignature" not in pc


def test_a_face_mark_word_in_the_oncamera_or_face_line_of_a_card_not_dealt_it_is_dropped():
    phys = {"distinguishingMark": "wire-rimmed glasses", "facialFeatures": "round face, deep dimples",
            "onCamera": "Hands folded at the waist, eyes up and off past the lens, dimples creasing as she bites back a grin. The one who waits."}
    prof = {"physicalCharacteristics": dict(phys)}
    assert G._drop_foreign_mark_words(prof, {"id": "npc:1"})
    assert "dimple" not in prof["physicalCharacteristics"]["onCamera"] and "dimple" not in prof["physicalCharacteristics"]["facialFeatures"]
    assert prof["physicalCharacteristics"]["onCamera"].startswith("Hands folded")
    own = {"physicalCharacteristics": {**phys, "distinguishingMark": "deep dimples"}}
    assert not G._drop_foreign_mark_words(own, {"id": "npc:1"})


def test_a_rewrite_that_fixes_the_look_fit_is_kept_even_with_a_colour_cap_still_over():
    """The acceptance rule: the weighted offenders must drop and no new look-fit offender may appear; perfection is not demanded."""
    taken = [_card(i, ["navy fleece pullover", "dark jeans"], f"sig{i}") for i in range(1, 5)]
    cast = taken + [_card(5, ["seersucker blazer", "loafers"], None, job="roofer")]
    g = G.SeasonGate("u"); g.n = 5
    for c in taken:
        g.accept(c["id"], {}, c, cast)
    assert G._wardrobe_score({"look-fit": ["upscale"], "colour": ["navy-blue"]}) > G._wardrobe_score({"colour": ["navy-blue"]})
    prof = {"physicalCharacteristics": dict(cast[4]["physicalCharacteristics"]), **{k: v for k, v in _profile("Nameb", "A roofer who reads a room first.").items() if k != "physicalCharacteristics"}}
    prof["physicalCharacteristics"] = {**LOOK, "wardrobe": ["seersucker blazer", "silk pocket square", "loafers"]}
    npc = {**_npc(5, "Nameb"), "vocation": "roofer", "age": 30}
    rep = g.repeats("npc:5", prof, npc, cast)
    assert "upscale" in rep["realism-wardrobe"].get("look-fit", [])

    async def rw(n, codes, message=None):  # fixes the fit but is still navy, which is already over the cap
        return {"physicalCharacteristics": {"wardrobe": ["navy work shirt", "canvas work pants"]}}
    asyncio.new_event_loop().run_until_complete(G._repetition_rewrite(g, prof, npc, cast, rw, "npc:5"))
    assert prof["physicalCharacteristics"]["wardrobe"][0] == "navy work shirt"


def test_the_fit_audit_asks_the_model_once_for_the_cast_and_rewrites_only_the_cards_it_names():
    cards = [{"id": f"npc:{i}", "name": f"P{i}", "vocation": "court reporter" if i == 1 else "welder", "age": 34, "hometown": "Macon, Georgia",
              "physicalCharacteristics": {"wardrobe": ["indigo scrub pants", "white clogs"] if i == 1 else ["grey work shirt", "dark jeans"],
                                          **({"lookSignature": "a long single braid"} if i == 2 else {"lookSignature": "a silver watch"} if i == 3 else {})}}
             for i in range(1, 4)]
    cards[2]["physicalCharacteristics"]["lookSignature"] = "a braided ponytail"  # the same category as card 2
    calls, written = [], []

    async def llm(messages):
        calls.append(messages)
        if len(calls) == 1:
            return '{"misfits": [{"id": "npc:1", "piece": "indigo scrub pants", "why": "a clinical uniform for a courtroom job"}, {"id": "npc:9", "piece": "x", "why": "unknown id"}]}'
        return '{"wardrobe": ["grey wool trousers", "ivory blouse", "low black flats"], "lookSignature": "a shell necklace"}'

    async def write(hid, fields):
        written.append((hid, fields))
        return {"accepted": True}
    n = asyncio.new_event_loop().run_until_complete(A.fit_audit_pass(cards, llm, write))
    assert n >= 1 and [w[0] for w in written][0] == "npc:1" and "npc:9" not in [w[0] for w in written]
    assert "no list of jobs or garments" in calls[0][0]["content"] and "scrub" not in calls[0][0]["content"].lower()
    assert cards[0]["physicalCharacteristics"]["wardrobe"][0] == "grey wool trousers"
    # the repeated-category card (3) is asked for a different kind, and only one card may take the free jewellery category
    sigs = [c["physicalCharacteristics"].get("lookSignature") for c in cards]
    assert sigs.count("a shell necklace") <= 1
    # a clean cast costs one call and changes nothing
    clean_cards = [{"id": f"npc:{i}", "vocation": "welder", "age": 30, "physicalCharacteristics": {"wardrobe": ["grey work shirt", "dark jeans"], "lookSignature": s_}}
                   for i, s_ in ((1, "a long single braid"), (2, "wire glasses"))]
    calls.clear(); written.clear()

    async def clean(messages):
        calls.append(messages)
        return '{"misfits": []}'
    assert asyncio.new_event_loop().run_until_complete(A.fit_audit_pass(clean_cards, clean, write)) == 0 and len(calls) == 1 and not written


def test_the_audit_gives_a_card_with_no_signature_and_no_wardrobe_one_rewrite_each():
    cards = [{"id": "npc:1", "vocation": "welder", "age": 30, "physicalCharacteristics": {"lookSignature": "wire glasses"}},
             {"id": "npc:2", "vocation": "welder", "age": 30, "physicalCharacteristics": {"wardrobe": ["grey work shirt", "dark jeans"]}}]
    written = []

    replies = ['{"wardrobe": ["rust flannel shirt", "canvas work pants"], "lookSignature": "a woven shell necklace"}',
               '{"lookSignature": "a plain cap"}']

    async def llm(messages):
        if "casting director of a reality show" in messages[0]["content"]:
            return '{"misfits": []}'
        return replies.pop(0)

    async def write(hid, fields):
        written.append((hid, sorted(fields)))
        return {"accepted": True}
    assert asyncio.new_event_loop().run_until_complete(A.fit_audit_pass(cards, llm, write)) == 2
    assert ("npc:1", ["lookSignature", "wardrobe"]) in written and ("npc:2", ["lookSignature"]) in written


def test_family_worn_is_read_from_the_style_line_and_a_look_fit_rewrite_replaces_that_line():
    card = {"id": "npc:1", "vocation": "county sheriff's deputy", "age": 32, "hometown": "Hilo, Hawaii", "presentation": "skater",
            "physicalCharacteristics": {"wardrobe": ["wool trousers", "ivory blouse"], "style": "skater style, skate shoes"}}
    assert "family-worn" in R.look_fits_life(card)
    card["physicalCharacteristics"]["style"] = "wool trousers, an ivory blouse"
    assert "family-worn" not in R.look_fits_life(card)


def test_olive_in_any_piece_counts_against_the_colour_cap_not_only_the_main_piece():
    cast = [_card(i, ["grey sweatshirt", "olive cargo pants"]) for i in range(1, 8)]
    g = G.SeasonGate("u"); g.n = 15
    asked = []
    for c in cast:
        asked.append("colour-any" in g.repeats(c["id"], {}, c, cast).get("realism-wardrobe", {}))
        g.accept(c["id"], {}, c, cast)
    assert R.cap_for("colour-any", "green", 15) == 4 and asked == [False] * 4 + [True] * 3
    assert R.tag_card(_card(1, ["black tee", "camo field jacket"]))["colour-any"] == ["green"]
    assert "colour-any" not in R.tag_card(_card(1, ["brown leather boots", "blue jeans"]))  # browns and denim are not the problem


def test_a_rewrite_answered_at_the_top_level_or_with_only_the_signature_is_read():
    # a writer asked for "just the field" often drops the physicalCharacteristics wrapper
    pc = _run("a braided ponytail", {"wardrobe": ["mustard corduroy overshirt", "faded black jeans"], "lookSignature": "a shell necklace"})
    assert pc["wardrobe"][0].startswith("mustard") and pc["lookSignature"] == "a shell necklace"
    # a signature-only ask is answered by a signature-only reply (the clothes stay)
    pc = _run("a braided ponytail", {"lookSignature": "a plain field watch"}, ["rust flannel", "dark jeans"])
    assert pc["wardrobe"][0] == "rust flannel" and pc["lookSignature"] == "a plain field watch"


def test_the_prompts_show_plain_colour_and_signature_words_never_the_internal_labels():
    g = G.SeasonGate("u"); g.n = 15; g.want_signature = True
    cast = [_card(i, ["red cardigan", "grey trousers"], "a braided ponytail" if i < 3 else None) for i in range(1, 7)]
    for c in cast[:5]:
        g.accept(c["id"], {}, c, cast)
    taken = g.taken_phrases("npc:6")
    msg = G.repetition_message({"realism-wardrobe": {"colour": ["red-pink"], "colour-any": ["green"], "signature": ["hair"]}}, taken)
    user = A.build_authoring_messages({"id": "npc:6", "vocation": "welder"}, taken={"phrases": taken})[1]["content"]
    for text in (msg, user, str(taken)):
        assert not R.label_leaks(text) and "red-pink" not in text and "facial-hair" not in text and "nails-makeup" not in text, text
    assert "red or pink" in msg and R.plain_label("signature", "scarf-tie") == "a scarf or tie"


def test_an_internal_label_in_a_card_text_is_a_look_problem_and_is_scrubbed_to_a_plain_word():
    for text in ("a red-pink cotton cardigan", "A bright red-pink knit beanie", "brown_tan boots"):
        assert R.label_leaks(text)
    assert R.scrub_labels("a red-pink canvas tote bag") == "a red canvas tote bag" and R.scrub_labels("a navy-blue shirt") == "a navy-blue shirt"
    prof = {"physicalCharacteristics": {"wardrobe": ["red-pink cotton cardigan", "grey trousers"], "lookSignature": "red-pink knit cardigans", "style": "tidy"}}
    npc = {"id": "npc:1", "age": 30}
    assert "label-leak" in A.look_problems(prof, npc)
    assert G._scrub_leaked_labels(prof) and not A.look_problems(prof, npc)
    assert prof["physicalCharacteristics"]["lookSignature"] == "red knit cardigans"


def test_a_signature_is_classified_by_its_first_category_word():
    tag = lambda s: R.tag_card({"physicalCharacteristics": {"lookSignature": s}}).get("signature")
    assert tag("a thin braided leather anklet worn with his boat shoes") == ["jewellery"]
    assert tag("A bright knit beanie pulled low over her fade") == ["headwear"]
    assert tag("long straight jet-black hair worn down") == ["hair"] and tag("a long single braid") == ["hair"]

"""ORW-1127: a houseguest's look is ONE coherent hand (heritage and age first), not independent dice.

The range tables below are written here on purpose, independent of the ledger's own tables: they say what a believable
(heritage, look) pairing is, and the dealt hands are checked against them across many seeds. Mixed-heritage and outlier
slots are marked by the deal (``lookKind``) and are exempt from the range checks.
"""
import re

from src import orwell_cast_genesis as G
from src import orwell_facet_ledger as L

DEEP = {"deep, cool-toned", "deep, warm-toned", "rich dark brown", "deep, neutral-toned", "medium-deep brown"}
FAIR = {"fair, neutral undertone", "light, neutral undertone", "light-medium, neutral undertone", "ruddy, fair", "fair, cool undertone", "fair with freckles", "fair, warm undertone", "pale, rosy", "light, olive undertone", "light-medium, warm undertone"}
PALE = {"fair, neutral undertone", "ruddy, fair", "fair, cool undertone", "fair with freckles", "fair, warm undertone", "pale, rosy"}
LIGHT_HAIR = re.compile(r"\b(blond|auburn|red|light brown)\b")
LIGHT_EYES = re.compile(r"\b(blue|green|gray-blue|light brown)\b")
CURLY = {"tight natural curls", "braids or locs", "twists or a natural afro", "a tapered fade"}
STRAIGHT = {"long and straight", "loose waves", "shoulder-length"}
GRAY = re.compile(r"\b(gr[ae]y|silver|salt-and-pepper)\b", re.I)

# group -> (forbidden skin cues, forbidden hair textures, forbidden colour/eye regexes); keyed by the engine's heritage labels
FORBID = {
    "Black American": (FAIR | PALE, STRAIGHT, (LIGHT_HAIR, LIGHT_EYES)),
    "Nigerian American": (FAIR | PALE | {"tan / olive", "golden brown", "light brown, warm"}, STRAIGHT, (LIGHT_HAIR, LIGHT_EYES)),
    "Mexican American": (DEEP - {"medium-deep brown"} | PALE, set(), (LIGHT_HAIR, LIGHT_EYES)),
    "Chinese American": (DEEP | {"fair with freckles", "pale, rosy", "ruddy, fair"}, CURLY, (LIGHT_HAIR, LIGHT_EYES)),
    "Korean American": (DEEP | {"tan / olive", "golden brown", "fair with freckles", "ruddy, fair"}, CURLY, (LIGHT_HAIR, LIGHT_EYES)),
    "South Asian American": (PALE | {"fair, cool undertone"}, CURLY - {"tight natural curls"}, (LIGHT_HAIR, LIGHT_EYES)),
    "Native American": (DEEP - {"medium-deep brown"} | PALE, CURLY - {"braids or locs"}, (LIGHT_HAIR, LIGHT_EYES)),
    "Irish American": (DEEP | {"tan / olive", "golden brown", "light brown, warm"}, CURLY, ()),
    "German American": (DEEP | {"golden brown", "light brown, warm"}, CURLY, ()),
    "Scandinavian American": (DEEP | {"tan / olive", "golden brown", "light brown, warm", "light, olive undertone"}, CURLY, ()),
}
HERITAGES = list(FORBID) + ["Italian American", "Puerto Rican", "Greek American", "Polish American", "Filipino American", "multiracial"]
WEIGHTS = {"Black American": 9, "Mexican American": 13, "Irish American": 13, "German American": 16, "Italian American": 12,
           "Polish American": 8, "Greek American": 5, "Chinese American": 2, "Korean American": 1, "South Asian American": 1,
           "Native American": 1, "Puerto Rican": 3, "Filipino American": 1, "Scandinavian American": 6, "Nigerian American": 2,
           "multiracial": 2}


def _cast(seed, count=15):
    """An engine-shaped roster: a weighted heritage draw (2 per heritage at most) and ages from the genesis age curve."""
    rng = G._Mulberry32(G._hash_seed(f"{seed}:test1127"))
    slots = G.assign_genesis_slots(seed, count)
    pool = [h for h, w in WEIGHTS.items() for _ in range(w)]
    used: dict = {}
    people = []
    for i in range(count):
        for _ in range(50):
            h = pool[rng.int(len(pool))]
            if used.get(h, 0) < 2:
                break
        used[h] = used.get(h, 0) + 1
        people.append({"ethnicity": h, "age": (slots[i]["ageLo"] + slots[i]["ageHi"]) // 2})
    return slots, people


def _mint(seed, slots, people):
    phys = [bool(s.get("physical")) for s in slots]
    try:
        return L.mint_facet_ledger(seed, len(people), phys, people=people)
    except TypeError:  # the ledger before ORW-1127 could not see heritage or age at all
        return L.mint_facet_ledger(seed, len(people), phys)


def test_no_hand_pairs_a_heritage_with_a_look_outside_its_range():
    bad = []
    checked = 0
    for seed in range(1, 121):
        slots, people = _cast(seed)
        for hand, p in zip(_mint(seed, slots, people), people):
            if hand.get("lookKind") in ("mixed", "outlier") or p["ethnicity"] not in FORBID:
                continue
            checked += 1
            skin_no, tex_no, rx = FORBID[p["ethnicity"]]
            text = f"{hand['hair']} {hand.get('facialFeatures', '')}"
            if hand["skinToneCue"] in skin_no:
                bad.append((seed, p["ethnicity"], "skin", hand["skinToneCue"]))
            if hand["hair"].split(",")[0] in tex_no:
                bad.append((seed, p["ethnicity"], "texture", hand["hair"]))
            for r in rx:
                if r.search(text):
                    bad.append((seed, p["ethnicity"], "colour/eyes", text))
    assert checked > 500
    assert not bad, bad[:8]


def test_no_young_slot_gets_gray_hair_and_older_slots_sometimes_do():
    older_gray = older = 0
    for seed in range(1, 121):
        slots, people = _cast(seed)
        for hand, p in zip(_mint(seed, slots, people), people):
            if p["age"] < 45:
                assert not GRAY.search(hand["hair"]), (seed, p, hand["hair"])
            if p["age"] >= 50:
                older += 1
                older_gray += bool(GRAY.search(hand["hair"]))
    assert older == 0 or older_gray > 0


def test_mixed_and_outlier_slots_are_marked_and_rare():
    kinds = {"mixed": 0, "outlier": 0, "heritage": 0}
    for seed in range(1, 121):
        slots, people = _cast(seed)
        hands = _mint(seed, slots, people)
        assert all(h.get("lookKind") in kinds for h in hands), "every hand says what kind of look it is"
        for h, p in zip(hands, people):
            kinds[h["lookKind"]] += 1
            if p["ethnicity"] == "multiracial":
                assert h["lookKind"] == "mixed"
        assert sum(h["lookKind"] == "mixed" for h, p in zip(hands, people) if p["ethnicity"] != "multiracial") <= L.MIXED_LOOK_MAX
    assert kinds["heritage"] > 3 * (kinds["mixed"] + kinds["outlier"])


def test_spread_and_dup_caps_still_hold_with_heritage_and_age_threaded_in():
    for seed in range(1, 121):
        slots, people = _cast(seed)
        hands = _mint(seed, slots, people)
        for key in ("heightBuild", "skinToneCue", "hair"):
            vals = [h[key] for h in hands]
            for v in set(vals):
                assert vals.count(v) <= L.FACET_DUP_CAP, (seed, key, v)
        # the cast-wide spread: a 15-slot cast does not collapse onto a couple of skin cues
        assert len({h["skinToneCue"] for h in hands}) >= 5, seed


def test_same_seed_and_cards_give_the_same_hands_and_the_cards_matter():
    slots, people = _cast(11)
    assert _mint(11, slots, people) == _mint(11, slots, people)
    other = [dict(p, ethnicity="Black American") for p in people]
    assert _mint(11, slots, people) != _mint(11, slots, other)


def test_the_hand_reaches_the_casting_card_with_its_face():
    slots, people = _cast(5)
    hand = _mint(5, slots, people)[0]
    line = G.render_slot_directive("npc:1", {**slots[0], "ink": False, "ledger": hand})
    assert hand["facialFeatures"] in line and hand["hair"] in line

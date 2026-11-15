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

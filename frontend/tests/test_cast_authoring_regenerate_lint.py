"""Cast authoring: a dealt-facet REGENERATE gets the same identity lint as the first draft.

When the first authored profile contradicts a dealt closed facet (a tattoo on a houseguest the casting office dealt no
ink), `_author_one` asks the model once more and, if the new profile adopts the dealt hand, uses it. Before this fix
the regenerated profile went straight to the write-back: the coherence lint (gender flip, script garble, an age
contradiction, the voice check) and the roster lint (a crosswired vocation, the hidden threads written around it)
had only checked the FIRST draft, so a regenerate that flipped a pinned identity committed it. Now the regenerate
is linted the same way, and if nothing coherent survives, the first draft's handling stands (its biography is
dropped rather than grafted). Roles only; every probe string is generic.
"""

import asyncio
import importlib
import json

import pytest

ca = importlib.import_module("src.orwell_cast_authoring")
enrichment_policy = importlib.import_module("src.enrichment_policy")
log_rings = importlib.import_module("src.log_rings")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


@pytest.fixture(autouse=True)
def _clean():
    enrichment_policy.clear_failures()
    for ring in (log_rings.OVERSEER, log_rings.LLMIO, log_rings.IO, log_rings.LIVE):
        ring.buf.clear()
    yield
    enrichment_policy.clear_failures()


SKELETON_LOOK = {  # the dealt hand: no visible ink anywhere
    "heightBuild": "average height, lean", "skinTone": "warm medium", "hair": "short dark",
    "facialFeatures": "sharp jaw", "distinguishingMark": "none notable", "ageLook": "early thirties",
    "style": "understated",
}
NPC = {"id": "npc:1", "genderPresentation": "woman", "age": 31, "vocation": "pastry chef",
       "physicalCharacteristics": SKELETON_LOOK}

INKED_BIO = ("She runs the early shift at a bakery and has a full sleeve tattoo of wheat stalks. She keeps her "
             "circle small and loyal, and never misses a sunrise.")
COHERENT_BIO = ("She runs the early shift at a bakery and never misses a sunrise. She keeps her circle small and "
                "loyal, and her sourdough starter is older than her car.")
FLIPPED_BIO = ("He runs the early shift at a bakery and never misses a sunrise. He keeps his circle small and "
               "loyal, and his sourdough starter is older than his car.")


def _author(replies):
    """Drive `author_cast` with a scripted model: the first reply, then the regenerate reply."""
    queue = list(replies)
    written = []

    async def _llm(_messages):
        return json.dumps(queue.pop(0))

    async def _write(profile):
        written.append(profile)
        return {"accepted": True}

    n = _run(ca.author_cast([dict(NPC)], _llm, _write, user="probe-user"))
    return n, written, queue


def _red(user="probe-user"):
    return {r["callClass"] for r in enrichment_policy.failures(user)}


def test_a_regenerate_that_flips_the_pinned_gender_is_linted_before_write_back():
    n, written, left = _author([
        {"biography": INKED_BIO, "physicalCharacteristics": SKELETON_LOOK},
        {"biography": FLIPPED_BIO, "physicalCharacteristics": SKELETON_LOOK},
    ])
    assert left == [], "the facet conflict must trigger exactly one regenerate"
    assert n == 1
    assert "biography" not in written[0], "a gender-flipped regenerated biography must never commit"
    assert written[0].get("physicalCharacteristics") == SKELETON_LOOK
    assert "identity-incoherence" in _red()


def test_a_regenerate_that_crosswires_the_vocation_drops_it_and_its_threads():
    n, written, _ = _author([
        {"biography": INKED_BIO, "physicalCharacteristics": SKELETON_LOOK},
        {"biography": COHERENT_BIO, "physicalCharacteristics": SKELETON_LOOK, "vocation": "commercial airline pilot",
         "secrets": ["She is hiding a near-miss incident from the airline board review."]},
    ])
    assert n == 1
    assert "vocation" not in written[0], "the committed occupation stands"
    assert "secrets" not in written[0], "threads written around the crosswired job are dropped too"
    assert written[0].get("biography") == COHERENT_BIO


def test_a_clean_regenerate_still_commits_whole():
    n, written, _ = _author([
        {"biography": INKED_BIO, "physicalCharacteristics": SKELETON_LOOK},
        {"biography": COHERENT_BIO, "physicalCharacteristics": SKELETON_LOOK},
    ])
    assert n == 1
    assert written[0]["biography"] == COHERENT_BIO
    assert "identity-incoherence" not in _red()


def test_a_regenerate_with_nothing_coherent_falls_back_to_the_first_draft_without_its_biography():
    # The regenerate is ONLY a gender-flipped biography: after the lint nothing writable is left, so the first
    # draft's adopt-the-skeleton handling stands (drop the inked biography, keep its facet block for the engine).
    n, written, _ = _author([
        {"biography": INKED_BIO, "physicalCharacteristics": SKELETON_LOOK, "weakness": "Trusts a kind word too fast."},
        {"biography": FLIPPED_BIO},
    ])
    assert n == 1
    assert "biography" not in written[0]
    assert written[0].get("weakness") == "Trusts a kind word too fast."

"""ORW-248 (prod 2026-11-07): Ryne experienced a full nominations ceremony the engine never ran. Production was holding nominations ("not due yet ... the house stays social") but the narrator voiced the
RITUAL anyway - the key walk, "the two without a key", "up for eviction this week", "the nomination ceremony begins" - never the word "nominate", so both closed-set pre-emission gates
(`_sentence_has_closed_set_claim`, `_narration_claims_outcome`) let it stream and only a post-hoc desync caught it. The ritual cues now count as a nomination claim while no nominee is committed.
Roles only; negatives pin that ordinary social prose and hypotheticals still stream."""
import importlib

ch = importlib.import_module("routes.chat_helpers")

LIVE = {"phase": "nominations", "week": 1, "noms": [], "hoh": "npc:3", "started": True}

RITUAL = {
    "key walk": "The HOH walks the line with the little keys, handing one to each houseguest in turn. Two people are left without. She stops in front of the nominee pair. \"This is purely strategic. Nothing personal.\"",
    "turns a key": "The HOH turns a key for the first safe houseguest, then another, and the room holds its breath.",
    "up for eviction": "Two houseguests are up for eviction this week, the keys all handed out.",
    "ceremony begins": "The nomination ceremony begins. The house gathers in the living room as the HOH reaches for the box of keys.",
    "last two": "The last two houseguests are left without a key and stand together.",
    # ORW-915: the ritual voiced as a list, as the dev narrator did in Fable's week-1 run (roles only here)
    "key list": "The HOH starts at the far end and works her way around: a key for Houseguest A, a key for Houseguest B, a key for Houseguest C, each one set down with a small click.",
    "nothing in front of them": "Then there are two people in the room with nothing in front of them, and the HOH looks up.",
    "two keys in hand": "The HOH stands at the head of the room with the two keys in her hand.",
    "about to name": "The HOH is about to name the nominees.",
}

SOCIAL = {
    "pocket keys": "I stuff my room keys in my pocket and ask the nearest houseguest how their day went.",
    "hypothetical": "If the HOH puts me on the block I will fight, and they know it.",
    "plain": "The kitchen hums. Someone laughs. A door opens. Footsteps.",
    "drink": "A houseguest hands me a drink and we talk about the week ahead.",
    "a key for the door": "I ask the HOH to cut a key for the storage room door.",
    "nothing in front": "Two people at the pool table sit with nothing to say to each other.",
    "about to name a plan": "The HOH is about to name the house's new quiet hour.",
}


def test_ritual_narration_of_a_ceremony_the_engine_never_ran_is_cut():
    for name, text in RITUAL.items():
        assert ch._sentence_has_closed_set_claim(text), f"{name}: the cheap gate must see the ritual as a nomination claim"
        assert ch._narration_claims_outcome(text, dict(LIVE), dict(LIVE)), f"{name}: no nominee is committed - the ritual is a phantom ceremony and must be cut"


def test_ordinary_social_prose_and_hypotheticals_still_stream():
    for name, text in SOCIAL.items():
        assert not ch._narration_claims_outcome(text, dict(LIVE), dict(LIVE)), f"{name}: creative/social prose must never be policed"


def test_once_the_engine_committed_the_nominees_the_ritual_recap_is_not_a_phantom():
    live = dict(LIVE, noms=["npc:5", "npc:6"])
    for name in ("key walk", "turns a key", "last two"):
        assert not ch._narration_claims_outcome(RITUAL[name], dict(live), dict(live)), f"{name}: after the engine ran the ceremony a recap of it is fine"


def test_orw481_key_and_left_without_need_nomination_context():
    """ORW-481 (review 4502149708): a door key or 'left without a drink' is not the nominations ritual."""
    from routes.chat_helpers import _CLAIM_NOMINATED_RE
    assert not _CLAIM_NOMINATED_RE.search("She turns the key in the bedroom door.")
    assert not _CLAIM_NOMINATED_RE.search("Both are left without a drink.")
    assert _CLAIM_NOMINATED_RE.search("The HOH turns a key for the first safe houseguest.")

"""ORW-481 (retro review of #2632): the card runner picks Skip ahead over Keep watching whatever order the engine lists them in. Run: python3 -m pytest scripts/live-run/test_live_week_cards.py"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from live_week import simplest_option  # noqa: E402


def test_skip_wins_over_keep_in_either_order():
    assert simplest_option(["Keep watching", "Skip ahead"]) == 1
    assert simplest_option(["Skip ahead", "Keep watching"]) == 0


def test_compete_then_keep_and_nothing():
    assert simplest_option(["Sit out", "Compete"]) == 1
    assert simplest_option(["Use it", "Do not use the veto"]) == 1
    assert simplest_option(["Left", "Right"]) is None


def _score(turns):
    from live_short import score
    checks = []
    score(turns, checks, lambda cid, ok, detail, severity="fail": checks.append({"id": cid, "ok": bool(ok), "severity": severity}), 120)
    return checks


def _turn(label, text, clock="8:10am, Day 2"):
    return {"label": label, "msg": "x", "secs": 5, "phase": "hoh-competition", "clock": clock, "ds": None, "text": text, "settled": True, "finalized": True,
            "new_bubbles": 1 if text else 0, "timed_out": False, "phase_before": "hoh-competition", "harness_jump": 0}


def test_a_card_turn_that_narrated_is_still_scored_for_machinery():
    bad = [c for c in _score([_turn("x-card", "The NPC says npc:3 will advanceGame now.")]) if c["id"].startswith("T3") and not c["ok"]]
    assert bad, "machinery in a card turn's narration must fail T3"
    assert not [c for c in _score([_turn("x-card", "")]) if c["id"].startswith(("T1", "T2"))], "a silent card click needs no bubble"


def test_clock_claim_follows_the_replys_own_pm_word():
    ids = lambda text, clock: [c for c in _score([_turn("a", text * 30, clock)]) if c["id"].startswith("C3") and not c["ok"]]
    assert ids("It is 8:10 at night. ", "8:10am, Day 2"), "8:10 at night against an 8:10am engine clock must warn"
    assert not ids("It is 8:10 at night. ", "8:10pm, Day 2")

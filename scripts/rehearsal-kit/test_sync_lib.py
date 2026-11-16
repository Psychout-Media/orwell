"""ORW-506: offline tests for sync_lib.py (the card-aware / toast-synchronised driver's decisions). Run: python3 -m pytest scripts/rehearsal-kit/test_sync_lib.py"""
import os, sys
import pytest
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sync_lib as sl  # noqa: E402


def test_parse_script_skips_comments_and_reads_toast_lines():
    got = sl.parse_script("# c\n\nHi there\nnext\n@toast Cheers, to the room\n  next  \n")
    assert got == [{"kind": "say", "text": "Hi there"}, {"kind": "say", "text": "next"}, {"kind": "toast", "text": "Cheers, to the room"}, {"kind": "say", "text": "next"}]


def test_parse_script_refuses_an_unknown_directive_and_ignores_an_empty_toast():
    with pytest.raises(ValueError):
        sl.parse_script("@wait 5")
    with pytest.raises(ValueError):
        sl.parse_script("@toast")        # an empty toast is not a message


def test_the_shipped_hangout_script_still_parses_as_plain_lines():
    for name in ("script-a21b.txt", "script-hangout-premiere.txt", "script-a15.txt"):
        assert all(e["kind"] == "say" for e in sl.parse_script(open(os.path.join(HERE, name)).read()))


@pytest.mark.parametrize("ent,sent,want", [
    (None, 0, "skip"), ({}, 0, "skip"),
    ({"stage": "entrances"}, 0, "release"),
    ({"stage": "toast", "playerToast": "later", "toastRemaining": 3}, 2, "release"),
    ({"stage": "toast", "playerToast": "now", "toastRemaining": 1}, 5, "send"),
    ({"stage": "toast", "playerToast": "done", "toastRemaining": 2}, 1, "skip"),
    ({"stage": "done", "toastRemaining": 0}, 1, "skip"),
    ({"stage": "toast", "playerToast": "later"}, 12, "skip"),      # the bound of `next` is spent
])
def test_toast_gate(ent, sent, want):
    assert sl.toast_gate(ent, sent, 12) == want


def test_now_wins_even_when_the_bound_is_spent():
    assert sl.toast_gate({"stage": "toast", "playerToast": "now"}, 99, 12) == "send"


def test_card_pick_follows_the_live_week_rule():
    sys.path.insert(0, os.path.join(HERE, "..", "live-run"))
    import live_week
    for opts in (["Keep watching", "Skip ahead"], ["Skip ahead", "Keep watching"], ["Sit out", "Compete"], ["Use it", "Do not use the veto"], ["Left", "Right"], []):
        assert sl.simplest_option(opts) == live_week.simplest_option(opts), opts


def test_pick_for_card_cases():
    assert sl.pick_for_card({"title": "Veto", "opts": ["Save Pat Q", "Do not use"]}, "Pat Q") == [0]
    assert sl.pick_for_card({"title": "Veto", "opts": ["Use on A", "Do not use"]}, "Pat Q") == [1]
    assert sl.pick_for_card({"title": "Nominations", "opts": ["A", "B", "C"]}) == [0, 1]
    assert sl.pick_for_card({"title": "Vote", "opts": ["A", "B"]}) == [0]
    assert sl.pick_for_card({"title": "x", "opts": []}) == []


def test_card_budget():
    assert sl.card_budget_left(0, 2) and sl.card_budget_left(1, 2) and not sl.card_budget_left(2, 2)

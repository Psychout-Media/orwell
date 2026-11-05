"""A68: the vote-TALLY claim regex must keep the separator on ONE line. `\\s+` before/after the dash spanned a newline, so a markdown list "- one\\n- two" read as a "one - two" tally and the
pre-ceremony board-absence cut replaced the whole scene with "The live feeds cut away..." (found by the A58 golden-render harness). Real tallies stay caught. Roles only."""
import importlib

ch = importlib.import_module("routes.chat_helpers")


def test_a_markdown_list_of_number_words_is_not_a_tally():
    for text in ("They say:\n\n- one\n- two\n\n", "Items:\n- three\n- four", "1\n- 2", "one\n– two"):
        assert not ch._CLAIM_TALLY_RE.search(text), f"false positive on {text!r}"


def test_real_tallies_are_still_caught():
    for text in ("It ends 7 votes to 2.", "Seven votes to two.", "three to two, evicted", "five - four", "six to evict", "4 – 3", "7 votes - 2", "five – four", "nine votes to evict", "it's 7 to 2"):
        assert ch._CLAIM_TALLY_RE.search(text), f"missed a real tally: {text!r}"

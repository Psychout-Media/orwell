"""ORW-987: an ally's spoken renewal of a deal that ran out was never recorded, so the player ended the week with no live deal.

The deal back-fill belt (0039) is the same error correction: it now also fires on renewal language, and its extraction counts a renewal both sides agree to as a deal struck now. The engine still decides
(makeDeal), and the model-driven call keeps precedence. Roles only.
"""
import pytest

from src import agent_loop as al


@pytest.mark.parametrize("line", [
    "We're still good, you and me.",
    "Same deal next week?",
    "Our deal still stands, right?",
    "I want to renew it for this week.",
    "Let's re-up before nominations.",
    "Same as last week: you keep me, I keep you.",
])
def test_renewal_language_wakes_the_deal_belt(line):
    assert al._DEAL_SIGNAL_RE.search(line), line


@pytest.mark.parametrize("line", [
    "The kitchen is still a mess.",
    "I slept the same as ever.",
    "He sat down with the same face as always.",
])
def test_ordinary_talk_does_not(line):
    assert not al._DEAL_SIGNAL_RE.search(line), line


def test_the_extraction_is_told_a_renewal_counts():
    import inspect
    src = inspect.getsource(al._auto_record_deal)
    assert "RENEWAL" in src and "struck now" in src

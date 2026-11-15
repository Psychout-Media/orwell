"""ORW-437 (review of #2737): the nap detector reads the speaker as the napper, and the length in words."""
import pytest

from src.agent_loop import _nap_hours_from_text, _player_means_nap


@pytest.mark.parametrize("text,hours", [("I lie down for four hours.", 4.0), ("I take a nap for six hours.", 6.0), ("I take a nine-hour nap.", 9.0)])
def test_word_number_hours_are_parsed(text, hours):
    assert _nap_hours_from_text(text) == hours


@pytest.mark.parametrize("text", ["My roommate will take a nap.", "My friend is going to take a nap now.", "Her dog will take a nap."])
def test_someone_elses_nap_is_not_the_players(text):
    assert _player_means_nap(text) is False


def test_the_players_own_nap_still_counts():
    assert _player_means_nap("I take a nap now.") is True
    assert _player_means_nap("I'll lie down for a nap.") is True

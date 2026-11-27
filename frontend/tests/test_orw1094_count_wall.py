"""ORW-1094 (Coordinator calls, 2026-11-27): premiere turns run the empty-room and asleep checks too; "the kitchen is empty" with the player alone passes ("no one else"); "only N asleep" is exact. Roles only."""
import pytest

from test_orw205_headcount_guard import _view
from test_orw376_engine_counts import _USER, _clean, _emit, _fake, _run, _wa, chat_helpers  # noqa: F401


def _board(*, others=3, asleep=0, nearby=()):
    wa = _wa(others=others)
    wa["counts"]["asleep"] = asleep
    wa["nearby"] = [{"room": r, "present": [{"id": "x", "name": "X"}]} for r in nearby]
    return wa


@pytest.fixture(autouse=True)
def _fresh():
    chat_helpers._DESYNC_REGROUND.pop("u-orw376", None)
    yield


@pytest.mark.parametrize("sentence", ["The backyard is empty.", "Nine houseguests are asleep."])
def test_a_premiere_turn_checks_empty_rooms_and_sleepers(monkeypatch, sentence):
    _fake(monkeypatch, _board(asleep=0, nearby=("backyard",)), premiere=_view(inside=9, player_inside=True))
    assert _emit(sentence) is False
    assert _run(chat_helpers.screen_headcount_wall(_USER, sentence + " Fine.")) == " Fine."


def test_the_kitchen_is_empty_passes_with_the_player_alone(monkeypatch):
    _fake(monkeypatch, _board(others=0))
    assert _emit("The kitchen is empty.") is True


def test_only_n_asleep_is_exact(monkeypatch):
    _fake(monkeypatch, _board(asleep=11))
    assert _emit("Only two houseguests are asleep.") is False
    assert _emit("Only eleven are asleep.") is True
    assert _emit("Two of them are asleep upstairs.") is True  # a subgroup

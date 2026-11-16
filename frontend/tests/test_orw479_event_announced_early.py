"""ORW-479: production must not announce the scheduled event as starting NOW while the engine's day schedule says it is minutes away (due=false). Real stream loop (the ORW-408
`_drive` harness), shown AND stored as whole strings. A kept, true sentence is never touched. Roles only."""
import pytest

from tests.test_orw408_sentence_rewrite import _drive

pytestmark = [pytest.mark.usefixtures("non_game_text_routing"), pytest.mark.usefixtures("zero_clocks_off")]

T3 = "Rain taps the glass. A cup is set down. The kettle ticks. "
T3S = T3.strip()
ANNOUNCE = "Houseguests. Head of Household competition. Backyard. Now. "


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("ORWELL_PREDISPLAY_REWRITE", "0")


def _schedule(monkeypatch, **ds):
    from src import orwell_engine as oe

    async def gs(user=None, timeout=None):
        return {"started": True, "daySchedule": {"next": "hoh-competition", "tomorrow": False, "due": False, "minutesUntil": 5, **ds}}
    monkeypatch.setattr(oe, "get_game_state", gs)


def _round(monkeypatch, deltas):
    emitted, _c, stored, _n = _drive(monkeypatch, rounds_scripts=[{"deltas": deltas}], flag="0")
    return emitted.split("done.")[0].strip(), stored[0].strip()


def test_the_early_announcement_is_never_shown_or_stored(monkeypatch):
    _schedule(monkeypatch)
    shown, stored = _round(monkeypatch, [T3 + ANNOUNCE + "Rain keeps falling. "])
    expected = T3S + " Rain keeps falling."
    assert shown == expected and stored == expected, (shown, stored)


def test_the_one_sentence_form_is_held_too(monkeypatch):
    _schedule(monkeypatch)
    shown, stored = _round(monkeypatch, [T3 + "The Head of Household competition begins now. " + "Rain keeps falling. "])
    expected = T3S + " Rain keeps falling."
    assert shown == expected and stored == expected, (shown, stored)


@pytest.mark.parametrize("ds", [{"due": True, "minutesUntil": 0}, {"tomorrow": True}, {"next": "nominations"}, {"minutesUntil": 0}])
def test_the_announcement_stands_when_the_event_is_due_or_is_not_the_next_one_today(monkeypatch, ds):
    _schedule(monkeypatch, **ds)
    shown, stored = _round(monkeypatch, [T3 + ANNOUNCE + "Rain keeps falling. "])
    expected = (T3 + ANNOUNCE + "Rain keeps falling.").strip()
    assert shown == expected and stored == expected, (shown, stored)


def test_talk_about_the_comp_without_an_announcement_is_untouched(monkeypatch):
    _schedule(monkeypatch)
    line = "Everyone wonders when the Head of Household competition will be. Now and then someone checks the door. "
    shown, stored = _round(monkeypatch, [T3 + line])
    expected = (T3 + line).strip()
    assert shown == expected and stored == expected, (shown, stored)


def test_an_unreadable_engine_state_lets_the_text_through(monkeypatch):
    from src import orwell_engine as oe

    async def boom(user=None, timeout=None):
        raise RuntimeError("engine down")
    monkeypatch.setattr(oe, "get_game_state", boom)
    shown, stored = _round(monkeypatch, [T3 + ANNOUNCE])
    assert shown == (T3 + ANNOUNCE).strip() and stored == shown


@pytest.mark.parametrize("deltas", [
    [T3, "Houseguests. ", "Head of Household competition. ", "Backyard. ", "Now. ", "Rain keeps falling. "],      # one sentence per chunk, as the live stream sentence-buffers
    [T3 + "Houseguests. Head of Household competition. ", "Backyard. Now. Rain keeps falling. "],                    # the call split between two chunks
])
def test_the_announcement_is_held_when_the_stream_delivers_it_a_chunk_at_a_time(monkeypatch, deltas):
    _schedule(monkeypatch)
    shown, stored = _round(monkeypatch, deltas)
    assert "Head of Household" not in shown and "Now." not in shown and "Backyard" not in shown, shown
    assert shown.endswith("Rain keeps falling.") and shown.startswith(T3S), shown
    # (an already-shown "Houseguests." lead-in of a per-sentence stream cannot be recalled; nothing of the call itself remains)
    assert stored == shown, (shown, stored)   # what was shown is what is stored


# ── review of #2826 ───────────────────────────────────────────────────────────────────────────────────────────────────
def test_only_the_held_calls_own_words_are_held_other_short_sentences_survive(monkeypatch):
    _schedule(monkeypatch)
    shown, stored = _round(monkeypatch, [T3, "Houseguests. ", "Head of Household competition. ", "Now. ", "She nods. ", "Ana laughs. ", "Okay. ", "The kettle ticks. "])
    assert "Head of Household" not in shown and "Now." not in shown, shown
    for kept in ("She nods.", "Ana laughs.", "Okay.", "The kettle ticks."):
        assert kept in shown, (kept, shown)
    assert stored == shown, (shown, stored)


def test_the_tail_state_is_gone_when_the_turn_ends_and_is_a_season_store(monkeypatch):
    from src import agent_loop as al
    _schedule(monkeypatch)
    _round(monkeypatch, [T3, "Head of Household competition. ", "Now. "])
    assert al._ANN_HELD == {}, "a held announcement's tail window must not outlive its turn"
    assert any(al._ANN_HELD is st for st in al._SEASON_PACING_STORES), "a per-owner store joins the new-season reset"


def test_the_held_bare_line_leaves_no_empty_line_in_shown_or_stored(monkeypatch):
    _schedule(monkeypatch)
    shown, stored = _round(monkeypatch, ["Rain taps the glass.\n\nHead of Household competition.\n\nThe kettle ticks.\n"])
    assert shown == "Rain taps the glass.\n\nThe kettle ticks." and stored == shown, (shown, stored)


def test_the_generic_the_competition_begins_now_is_held_when_one_event_is_next(monkeypatch):
    _schedule(monkeypatch)
    shown, stored = _round(monkeypatch, [T3 + "The competition begins now. Rain keeps falling. "])
    expected = T3S + " Rain keeps falling."
    assert shown == expected and stored == expected, (shown, stored)


@pytest.mark.parametrize("line", [
    'Ana says, "The Head of Household competition starts now, right?" ',   # a houseguest's quoted question
    'Ana says, "The competition begins now." ',                            # a houseguest's quoted line, not production's call
    "Does the Head of Household competition begin now? ",                  # a narrator question
])
def test_dialogue_and_questions_about_the_event_are_not_held(monkeypatch, line):
    _schedule(monkeypatch)
    shown, stored = _round(monkeypatch, [T3 + line + "Rain keeps falling. "])
    expected = (T3 + line + "Rain keeps falling.").strip()
    assert shown == expected and stored == expected, (shown, stored)

"""F-6 / N-6 (rehearsal 2026-11-03): a later round that RE-TELLS the shown scene is dropped whole (the model ignores "do not reopen"), and a
blank MODEL turn on a readable board states the engine's board facts instead of "the moment hangs for a beat". Roles only."""
import re

from src import agent_loop

SHOWN = (
    "The room doesn't move for a second. Then Role A stands up — not fast, just stands — and his chair scrapes back.\n\n"
    "@[Role A] — All right. He nods once at the floor.\n\n"
    "And then the door opens onto the dark, and he's gone."
)


def test_a_round_that_reopens_the_shown_scene_is_a_replay():
    assert agent_loop._replays_shown("The room doesn't move for a second. Then Role A lets out a breath and stands.", SHOWN)
    # tag / markdown prefixes do not hide it
    assert agent_loop._replays_shown("**The room doesn't move for a second.** Then more.", SHOWN)
    assert agent_loop._replays_shown("@[Role A] — He nods once at the floor. Then more.", "@[Role A] — He nods once at the floor. Then goes.")


def test_ordinary_continuation_is_never_a_replay():
    assert not agent_loop._replays_shown("The house is quiet after he leaves. Somebody lets out a long breath.", SHOWN)
    assert not agent_loop._replays_shown("Short one.", SHOWN)  # < 6 words
    # a five-word opening is never compared (the contract is a six-word prefix)
    assert not agent_loop._replays_shown("He nods at the floor. Then more.", "He nods at the floor. Then goes.")
    assert not agent_loop._replays_shown("The room doesn't move for a second.", "")  # nothing shown yet
    assert not agent_loop._replays_shown("", SHOWN)


def test_a_replay_of_any_shown_line_is_caught_even_across_a_bare_newline():
    shown = '**"Keisha."**\nThe reader closes the folder and sets it down.\nThe room is dead silent now.'
    assert agent_loop._replays_shown("The reader closes the folder and sets it down. More follows.", shown)


def test_only_the_opening_sentence_decides():
    # a later sentence that happens to repeat earlier prose does NOT make the round a replay
    assert not agent_loop._replays_shown("Morning comes slowly. The room doesn't move for a second.", SHOWN)


def test_blank_model_turn_on_a_readable_board_states_the_board():
    live = {"phase": "eviction", "week": 1, "hohName": "Role H", "nomNames": ["Role N1", "Role N2"], "vetoHolderName": "Role V", "evicted": 3}
    line = agent_loop._blank_turn_fallback_for_board(live, upstream_failed=False)
    assert "Role V holds the Power of Veto" in line and "Role H is Head of Household" in line
    assert "on the block: Role N1, Role N2" in line, "both nominees are stated"
    assert "3 houseguests evicted so far" in line, "the evicted count is stated"
    assert "hangs for a beat" not in line


def test_blank_fallback_keeps_the_old_lines_when_there_is_nothing_to_state():
    assert "hangs for a beat" in agent_loop._blank_turn_fallback_for_board(None, upstream_failed=False)
    assert "hangs for a beat" in agent_loop._blank_turn_fallback_for_board({}, upstream_failed=False)
    # an upstream failure is never masked by a board statement
    up = agent_loop._blank_turn_fallback_for_board({"phase": "eviction", "vetoHolderName": "Role V"}, upstream_failed=True)
    assert "Role V" not in up and "technical interlude" in up


def test_wired_at_both_emit_sites_and_the_blank_fallback():
    src = open(agent_loop.__file__, encoding="utf-8").read()
    assert len(re.findall(r"_replays_shown\(_clean, full_response\)", src)) == 2, "mid-loop emit + trailing flush"
    assert "_round_replay = False" in src
    assert "_blank_turn_fallback_for_board(" in src

"""F-8 (A-11 playtest, #1781): when the narrator provider is unreachable the player saw the canned "The moment hangs for
a beat…" line, which hid the outage. An upstream failure now says so (diegetically); a model-made blank keeps the old line."""
import os

from src import agent_loop

_SRC = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "agent_loop.py"), encoding="utf-8").read()


def test_an_upstream_failure_is_not_dressed_up_as_a_quiet_beat():
    line = agent_loop._blank_turn_fallback_line(upstream_failed=True)
    assert "technical interlude" in line and "again" in line
    assert "hangs for a beat" not in line


def test_a_model_made_blank_keeps_the_in_character_continuation():
    assert "hangs for a beat" in agent_loop._blank_turn_fallback_line(upstream_failed=False)


def test_neither_line_leaks_machinery():
    for up in (True, False):
        line = agent_loop._blank_turn_fallback_line(upstream_failed=up).lower()
        for bad in ("error", "503", "provider", "deepseek", "model", "token", "engine", "api"):
            assert bad not in line, (up, bad)


def test_the_double_blank_guard_uses_the_helper_with_the_turns_error_flag():
    assert "_blank_turn_fallback_line(upstream_failed=_turn_had_error)" in _SRC

"""ORW-784 (item 4): the engine's last-resort fallback lines are plainly system-styled notices, never a line in the narrator's voice.

A fallback is engine-authored text shown when the narrator produced nothing. In the narrator's voice ("The moment hangs for a beat ...", "Production's feed glitched ...") it reads as the
story, so the player answers it in character. Wrapped as a whole-message out-of-character aside (the `((...))` marker the surface already renders as a quiet producer aside), it reads as
what it is. Roles only."""
import importlib
import re

agent_loop = importlib.import_module("src.agent_loop")

_WRAP = re.compile(r"^\(\(.+\)\)$", re.S)
_NARRATOR_VOICE = ("hangs for a beat", "house keeps moving", "feed glitched", "we lost what")


def test_the_blank_model_fallback_is_a_whole_message_system_notice():
    line = agent_loop._blank_turn_fallback_line(upstream_failed=False)
    assert _WRAP.match(line.strip()), line
    assert not any(w in line.lower() for w in _NARRATOR_VOICE)


def test_the_empty_turn_producer_line_is_a_whole_message_system_notice():
    line = agent_loop._EMPTY_PRODUCER_LINE
    assert _WRAP.match(line.strip()), line
    assert not any(w in line.lower() for w in _NARRATOR_VOICE)


def test_old_stored_fallback_turns_are_still_recognised_and_dropped_from_history():
    old = "The moment hangs for a beat. The house keeps moving around you — what do you want to do?"
    msgs = [{"role": "assistant", "content": old}, {"role": "assistant", "content": "A real scene."}]
    assert agent_loop._drop_fallback_turns(msgs) == [{"role": "assistant", "content": "A real scene."}]
    new = agent_loop._blank_turn_fallback_line(upstream_failed=False)
    assert agent_loop._drop_fallback_turns([{"role": "assistant", "content": new}]) == []

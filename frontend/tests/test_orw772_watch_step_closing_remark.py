"""ORW-772 (3): a typed "That's all." at a staged watch step is the player ending their own remarks, not a press of Continue; the explicit continue words still move the step one step. Roles only."""
import os
import re

from routes import chat_helpers as c

SRC = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "routes", "chat_helpers.py"), encoding="utf-8").read()


def test_a_closing_remark_does_not_press_continue_but_the_continue_words_do():
    for t in ("That's all.", "that's all", "That's it.", "I'm done.", "Nothing else.", "No more.", "That's all, thanks everyone"):
        assert c._is_progress_only_message(t), f"positive control: {t!r} is a progress-only message for the stall-nudge"
        assert not c._is_watch_continue_message(t), f"{t!r} ended the player's own remarks; it must not advance the step"
    for t in ("next", "Continue", "ok", "go on", "keep going", "what's next", "let's go", "move on", "next round", "skip"):
        assert c._is_watch_continue_message(t), f"{t!r} still moves a watch step one step"
    assert not c._is_watch_continue_message("I'd like to say something. That's all.")


def test_the_watch_step_branch_uses_the_stricter_classifier():
    i = SRC.index("ORW-297: a typed \"next\" on ANY open ceremony WATCH step")
    branch = SRC[SRC.rfind("if isinstance(status, dict) and _is_watch_step", 0, i):i]
    assert "_is_watch_continue_message(player_msg)" in branch and "_is_progress_only_message(player_msg)" not in branch


def test_the_watch_step_directive_states_the_step_once_and_never_re_hands_the_floor():
    d = c._pending_barrier_directive({"kind": "ceremony-step", "text": "The speeches begin.", "by": {"name": "Casey"}})
    assert d and "The speeches begin." in d  # the engine's line is still quoted
    assert "State the step ONCE" in d and "do NOT announce the step again or hand them the floor a second time" in d
    assert "Do NOT call advanceGame or submitDecision" in d.replace("\n", " ")

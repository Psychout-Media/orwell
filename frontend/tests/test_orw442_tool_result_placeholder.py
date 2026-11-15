"""ORW-442: the model once echoed the harness placeholder "<tool result has been redacted>" as visible narration (slot-1 sweep, Day 3, a recordInteraction round: content was exactly that 31-char string).
The sentence-level machinery scrub (`_GAME_LEAK_SENTENCE_RE`, parity-locked with the JS `_MACHINERY_ASIDE_RE`) now treats "tool result(s)" like "tool call": the sentence is dropped, the scene is not."""
import os

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(*rel):
    with open(os.path.join(FRONTEND, *rel), encoding="utf-8") as f:
        return f.read()


def test_the_redaction_placeholder_is_dropped_but_the_scene_stays():
    from src.agent_loop import _scrub_game_leak
    assert _scrub_game_leak("<tool result has been redacted>").strip() == ""
    kept = _scrub_game_leak("The kitchen goes quiet. <tool result has been redacted> Kayla sets her mug down.")
    assert "redacted" not in kept and "The kitchen goes quiet." in kept and "Kayla sets her mug down." in kept


def test_ordinary_prose_about_results_is_untouched():
    from src.agent_loop import _scrub_game_leak
    for s in ("The results of the vote are in the envelope.", "Nobody likes the result.", "She reads the tool shed sign."):
        assert _scrub_game_leak(s) == s


def test_js_and_python_scrubs_stay_in_lockstep():
    assert r"\\btool (?:call|results?)\\b" in _read("static", "js", "markdown.js")
    assert r"\btool (?:call|results?)\b" in _read("src", "agent_loop.py")

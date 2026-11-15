"""ORW-442: the model once echoed the harness placeholder "<tool result has been redacted>" as visible narration (slot-1 sweep, Day 3, a recordInteraction round: content was exactly that 31-char string).
`_scrub_game_leak` (the live stream and the saved message) now cuts just that placeholder first (it has no sentence punctuation, so it would otherwise swallow the next sentence); the scene stays."""
def test_the_redaction_placeholder_is_dropped_but_the_scene_stays():
    from src.agent_loop import _scrub_game_leak
    assert _scrub_game_leak("<tool result has been redacted>").strip() == ""
    kept = _scrub_game_leak("The kitchen goes quiet. <tool result has been redacted> Kayla sets her mug down.")
    assert "redacted" not in kept and "The kitchen goes quiet." in kept and "Kayla sets her mug down." in kept


def test_ordinary_prose_about_results_is_untouched():
    from src.agent_loop import _scrub_game_leak
    for s in ("The results of the vote are in the envelope.", "Nobody likes the result.", "She reads the tool shed sign."):
        assert _scrub_game_leak(s) == s

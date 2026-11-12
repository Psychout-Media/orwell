"""ORW-293b: a turn's reply is persisted ONCE. The generator's `except (CancelledError, GeneratorExit)` branches save a "stopped partial" for a cut-short turn, and they
enclose the whole stream loop, including the stretch AFTER the [DONE] chunk was handled (the agent stream is still finalizing). A cancel/close landing there (a stop or
a session click right after the turn completes; wider on a slow host) saved the SAME reply a second time: two assistant rows with identical text (seq 3 and seq 5),
the intermittent doubled reply seen in test_orw139_no_empty_bubble[True]. Source pins: the flag is set by BOTH final saves and gates BOTH disconnect saves."""
import re
from pathlib import Path

SRC = (Path(__file__).resolve().parents[1] / "routes" / "chat_routes.py").read_text(encoding="utf-8")


def test_the_flag_is_initialised_once_per_turn_with_the_reply_buffer():
    i = SRC.index('            full_response = ""\n            # ORW-293b')
    assert "_final_saved = False" in SRC[i:i + 900]


def test_both_final_saves_set_the_flag_right_after_saving():
    calls = [m.start() for m in re.finditer(r"_saved_id = save_assistant_response\(", SRC)]
    assert len(calls) == 2, "expected the chat-mode and agent-mode final saves"
    for c in calls:
        tail = SRC[c:c + 3000]
        flag = tail.index("_final_saved = True")
        assert "yield " not in tail[tail.index(")\n", tail.index("brief_seen=")):flag], "the flag must be set right after the final save, before any yield (a yield is where a cancel can land)"


def test_both_disconnect_saves_skip_a_turn_already_saved():
    assert 'if full_response and not _final_saved:\n                        logger.info("Client disconnected mid-stream (chat mode)' in SRC
    assert 'if full_response and not _final_saved:\n                            logger.info("Client disconnected mid-stream for session %s, saving partial response' in SRC
    assert SRC.count("save_stopped_partial(") == 2 and SRC.count("not _final_saved") == 2

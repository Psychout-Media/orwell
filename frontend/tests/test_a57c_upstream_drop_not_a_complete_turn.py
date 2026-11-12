"""A57c: an UPSTREAM silent drop - the model connection closes mid-sentence with NO finish_reason and NO `[DONE]` - is an HONEST INTERRUPTION, never a complete saved turn.
It used to be reported as complete: llm_core's stream-end block yielded `[DONE]` unconditionally, so the agent loop saved the half sentence as the narrator's message and the browser's own no-[DONE] safeguard
(test_fault_probe_no_done.py) was never reached. Now llm_core surfaces a bare end (after real output, no tool call in flight) as a typed mid-stream `event: error` (`error_type: stream_dropped`), and the chat route
neither saves the partial nor records a consequence fallback for it. Both ways below: a normal turn is unchanged; a drop with no output at all is not mislabeled. Real loop: real engine + real FE route + a stub
narrator that drops. Roles only."""
import pytest

from _ws_turn_driver import ws_turn
from test_m0_3_midgen_join import STUB, _post_form, _post_json, _stack  # noqa: F401
from test_p0h_day1_clock_e2e import _session

pytestmark = pytest.mark.browser


def test_an_upstream_drop_is_not_reported_as_a_complete_saved_turn(_stack):  # noqa: F811
    sid = _session(_stack, "a57c")
    STUB.script.append({"deltas": ["The house goes quiet, and then "], "delay": 0, "drop": True})
    body = ws_turn(_stack["fe"], sid, "Hello house.", timeout=120, client_msg_id="a57c-1")["body"]   # ORW-44 S4b3: the game build is WebSocket-only
    assert "The house goes quiet, and then " in body, "precondition: the partial text streamed"
    saved_as_complete = '"type": "message_saved"' in body
    flagged = ('"type": "truncated"' in body) or ('"type": "stream_dropped"' in body) or ("event: error" in body)
    assert flagged and not saved_as_complete, f"a dropped upstream must surface as an interruption, not as a saved complete message: {body[:1500]!r}"


def _turn(stack, text, cid):
    sid = _session(stack, "a57c-" + cid)
    return ws_turn(stack["fe"], sid, text, timeout=120, client_msg_id=cid)["body"]


def test_a_normal_complete_turn_is_still_saved_and_not_flagged(_stack):  # noqa: F811
    STUB.script.append({"deltas": ["The house hums along. ", "Someone laughs."], "delay": 0})
    body = _turn(_stack, "Hello house.", "a57c-ok")
    assert '"type": "message_saved"' in body, "a normal turn is saved"
    assert "stream_dropped" not in body and "event: error" not in body


def test_a_drop_with_no_output_at_all_is_not_labelled_a_mid_reply_drop(_stack):  # noqa: F811
    STUB.script.append({"deltas": [], "delay": 0, "drop": True})
    body = _turn(_stack, "Hello again.", "a57c-empty")
    assert "stream_dropped" not in body, "no output was produced, so this is the existing empty-turn path, not a mid-reply drop"

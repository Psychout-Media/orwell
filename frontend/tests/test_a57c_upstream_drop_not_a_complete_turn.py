"""A57c (found while scoping A57/R6): an UPSTREAM silent drop - the model connection closes mid-sentence with NO finish_reason and NO `[DONE]` - is currently reported to the browser as a COMPLETE turn:
llm_core's stream loop ends and then yields `data: [DONE]` unconditionally (~llm_core.py:2287, the OpenAI-compatible path), so the agent loop saves the half sentence as the narrator's message, emits metrics,
message_saved and `[DONE]`, and the browser's own no-[DONE] safeguard (test_fault_probe_no_done.py) is never reached. That contradicts the project rule that an incomplete stream is an HONEST failure.

This test documents the gap with a REAL loop (real engine + real FE route + a stub narrator that drops the connection). It is `xfail(strict=True)`: today it fails as described; the day the server stops
reporting a dropped stream as complete, it XPASSes and strict mode turns that into a red run - delete the xfail then and keep the test. Roles only."""
import urllib.parse
import urllib.request

import pytest

from test_m0_3_midgen_join import STUB, _post_form, _post_json, _stack  # noqa: F401
from test_p0h_day1_clock_e2e import _session

pytestmark = pytest.mark.browser


@pytest.mark.xfail(strict=True, reason="A57c: an upstream drop with no finish_reason and no [DONE] is reported as a complete, saved turn")
def test_an_upstream_drop_is_not_reported_as_a_complete_saved_turn(_stack):  # noqa: F811
    sid = _session(_stack, "a57c")
    STUB.script.append({"deltas": ["The house goes quiet, and then "], "delay": 0, "drop": True})
    data = urllib.parse.urlencode({"message": "Hello house.", "session": sid, "client_msg_id": "a57c-1"}).encode()
    req = urllib.request.Request(_stack["fe"] + "/api/chat_stream", data=data, method="POST",
                                 headers={"content-type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=120) as r:
        body = r.read().decode("utf-8", "replace")
    assert "The house goes quiet, and then " in body, "precondition: the partial text streamed"
    saved_as_complete = '"type": "message_saved"' in body
    flagged = ('"type": "truncated"' in body) or ('"type": "stream_dropped"' in body) or ("event: error" in body)
    assert flagged and not saved_as_complete, "a dropped upstream must surface as an interruption, not as a saved complete message"

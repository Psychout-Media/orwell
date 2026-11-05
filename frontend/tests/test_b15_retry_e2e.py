"""B15 - a network retry never double-bills the clock or doubles the player's line (real engine + real /api/chat_stream + a scripted fake narrator).

The FE stream drops mid-reply (the client closes its read after the first bytes) and the client RESENDS the same message with the same clientMsgId. Asserts: (1) the first, dropped send billed exactly one
message-step; (2) the resend with the SAME id bills 0 extra minutes; (3) the transcript holds the player's line ONCE; (4) a NEW id after that bills +5 again. Roles only. Needs the built engine bundle
(skips cleanly without it); browser lane = serial, like the other real-stack pins.
"""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request

import pytest

from test_m0_3_midgen_join import _post_json, _stack  # noqa: F401
from test_p0h_day1_clock_e2e import STEP, _engine, _schedule, _send, _session, _start_day

pytestmark = pytest.mark.browser


def _drop_midreply(stack, session, text, client_msg_id):
    """POST the chat turn, read only the first bytes of the stream, then close the connection (a dropped stream)."""
    data = urllib.parse.urlencode({"message": text, "session": session, "client_msg_id": client_msg_id}).encode()
    req = urllib.request.Request(stack["fe"] + "/api/chat_stream", data=data, method="POST",
                                 headers={"content-type": "application/x-www-form-urlencoded"})
    r = urllib.request.urlopen(req, timeout=60)
    r.read(64)   # the stream has started
    r.close()    # ...and the client goes away mid-reply


def _user_lines(stack, session, text):
    with urllib.request.urlopen(stack["fe"] + f"/api/history/{session}", timeout=30) as r:
        body = json.loads(r.read().decode("utf-8", "replace"))
    rows = body if isinstance(body, list) else (body.get("messages") or body.get("history") or [])
    return [m for m in rows if isinstance(m, dict) and m.get("role") == "user" and text in str(m.get("content", ""))]


def _settle(stack, want_minutes, tries=40):
    """The server-side turn may finish after the client dropped: wait until the clock reads the expected value."""
    for _ in range(tries):
        s, _st = _schedule(stack)
        if s and s["minutesUntil"] == want_minutes:
            return s
        time.sleep(0.25)
    return _schedule(stack)[0]


def _play_drop_and_retry(stack):
    r = _post_json(stack["fe"], "/api/orwell/new-game", {"playerName": "P", "confirm": True}, timeout=120)
    assert r.get("started"), r
    sid = _session(stack, "b15-retry")
    sched, _ = _start_day(stack, sid)
    start = sched["minutesUntil"]
    assert start == 240, sched
    _drop_midreply(stack, sid, "The line that gets dropped.", "b15-dropped")
    after_drop = _settle(stack, start - STEP)
    _send(stack, sid, "The line that gets dropped.", "b15-dropped")  # the client's resend, SAME clientMsgId
    after_retry, _ = _schedule(stack)
    return sid, start, after_drop, after_retry


def test_dropped_stream_then_same_id_resend_bills_once_and_a_new_id_bills_again(_stack):  # noqa: F811
    sid, start, after_drop, after_retry = _play_drop_and_retry(_stack)
    assert after_drop["minutesUntil"] == start - STEP, f"the dropped send must have billed exactly one step: {after_drop}"
    assert after_retry["minutesUntil"] == start - STEP, f"a retry with the same clientMsgId must bill 0 extra minutes: {after_retry}"
    _send(_stack, sid, "A genuinely new line.", "b15-new")
    after_new, _ = _schedule(_stack)
    assert after_new["minutesUntil"] == start - 2 * STEP, f"a NEW id after the retry bills +5: {after_new}"


def test_dropped_stream_then_same_id_resend_keeps_one_player_line(_stack):  # noqa: F811
    """The fix: the retry adopts the recorded line - /api/history carries it ONCE and the narrator's context does too."""
    from test_m0_3_midgen_join import STUB
    sid, _start, _after_drop, _after_retry = _play_drop_and_retry(_stack)
    rows = _user_lines(_stack, sid, "The line that gets dropped.")
    detail = [(m.get("metadata", {}).get("_db_id"), m.get("metadata", {}).get("_seq"), m.get("metadata", {}).get("client_msg_id")) for m in rows]
    assert len(rows) == 1, f"the player's line must appear ONCE after a retry: {detail}"
    with STUB.lock:
        game_turns = [r for r in STUB.requests if r.get("stream") and r.get("tools")]
    last = game_turns[-1]  # the retry's narrator call
    seen = sum(1 for m in (last.get("messages") or []) if m.get("role") == "user" and "The line that gets dropped." in str(m.get("content", "")))
    assert seen == 1, f"the narrator must see the player's line once, saw {seen}"

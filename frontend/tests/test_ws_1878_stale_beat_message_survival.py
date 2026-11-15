"""#1878 — structural: stale-beat WS turn refusal preserves the player's typed message.

Acceptance criteria:
  • Stale-beat auto-retry once BEFORE the existing cleanup (no text loss).
  • The retry calls sendTurn with _finalMsgWithInject and no explicit expectedBeatSeq (uses lastBeatSeq()).
  • Auto-retry is bounded to exactly one retry (no loop).
  • Composer text is restored via msgEl.value = _finalMsgWithInject in the cleanup path.
  • Non-stale-beat errors also restore the composer text.

The structural approach mirrors test_ws_decision_wire.py: read the source, isolate the catch
block inside handleChatSubmit, and assert key patterns.
"""

import os
import re

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHAT_JS = os.path.join(FRONTEND, "static", "js", "chat.js")


@pytest.fixture(scope="module")
def chat_source():
    with open(CHAT_JS, encoding="utf-8") as f:
        return f.read()


def _ws_section(source: str) -> str:
    """Return the catch block from the handleChatSubmit WS stale-beat handler.

    Anchors on the unique #1878 comment inside the catch, then walks backward
    to find the enclosing `catch (err)` and brace-matches forward to its `}`.
    """
    anchor = "#1878: stale-beat auto-retry once"
    idx = source.find(anchor)
    assert idx != -1, "stale-beat retry comment must exist in chat.js"
    pre = source[:idx]
    catch_start = pre.rfind("catch (err)")
    assert catch_start != -1, "catch (err) must exist before the #1878 comment"
    cb_start = pre.find("{", catch_start)
    assert cb_start != -1, "opening brace after catch (err)"
    # Brace-match from cb_start
    depth = 0
    i = cb_start
    while i < len(source):
        if source[i] == "{":
            depth += 1
        elif source[i] == "}":
            depth -= 1
            if depth == 0:
                break
        i += 1
    return source[catch_start:i + 1]


def test_stale_beat_retry_block_exists(chat_source):
    body = _ws_section(chat_source)
    # The stale-beat guard must be the FIRST check in the catch block
    assert "err.code === \"stale-beat\"" in body, \
        "stale-beat error code check must exist in the catch block"
    assert "sendTurn" in body, \
        "the retry path must call sendTurn"
    # The retry must carry _finalMsgWithInject
    assert "_finalMsgWithInject" in body, \
        "the retry must re-send the original message (_finalMsgWithInject)"
    # No explicit expectedBeatSeq in the retry — sendTurn defaults to lastBeatSeq()
    # Find the retry sendTurn call and check expectedBeatSeq: (property, not comment) is NOT there
    _call = "await (window.OrwellWs.sendTurnWhenLive || window.OrwellWs.sendTurn)({"  # ORW-437: the retry uses the reconnect-aware wrapper (falls back to sendTurn)
    retry_send = body[body.find(_call):body.find("});", body.find(_call))]
    # Check for actual property key (with colon), ignoring comments with the word
    assert "expectedBeatSeq:" not in retry_send, \
        "the retry sendTurn must NOT pass expectedBeatSeq (uses lastBeatSeq() as default)"


def test_retry_bounded_once(chat_source):
    body = _ws_section(chat_source)
    # Count occurrences of sendTurn inside the catch: one original (the outer try) and one in the retry.
    # The original sendTurn is in the try block, not the catch. Inside the catch we only expect one.
    # Count "sendTurn(" calls that are inside the catch
    send_calls_in_catch = body.count("(window.OrwellWs.sendTurnWhenLive || window.OrwellWs.sendTurn)(") + body.count("window.OrwellWs.sendTurn(")  # ORW-437: the wrapper form counts as the one retry call
    assert send_calls_in_catch == 1, \
        f"retry must call sendTurn exactly once (found {send_calls_in_catch} calls in catch)"
    # No loop structure around the retry
    assert "while" not in body[:body.find("// ── Pre-stream refusal")], \
        "retry must NOT be inside a loop"
    assert "for" not in body[:body.find("// ── Pre-stream refusal")], \
        "retry must NOT be inside a for loop"


def test_composer_text_restored(chat_source):
    body = _ws_section(chat_source)
    # The composer restoration must exist in the catch block
    assert "document.getElementById('message')" in body, \
        "composer restoration must get the message element"
    assert "msgEl.value = _finalMsgWithInject" in body, \
        "composer text must be restored to _finalMsgWithInject"
    # Composer restore must be BEFORE the softReloadHistory call (but after cleanup)
    cleanup_end = body.rfind("try { if (holder) holder.remove();")
    restore_pos = body.find("msgEl.value = _finalMsgWithInject")
    history_pos = body.find("softReloadHistory")
    assert restore_pos > cleanup_end, \
        "composer restoration must come AFTER the existing cleanup"
    assert restore_pos < history_pos or history_pos == -1, \
        "composer restoration must come BEFORE softReloadHistory"


def test_non_stale_beat_also_restores(chat_source):
    body = _ws_section(chat_source)
    # The composer restoration must be OUTSIDE the stale-beat if block (fallthrough path)
    stale_if_end = body.find("// ── Pre-stream refusal")
    assert stale_if_end != -1, "the pre-stream refusal comment must exist as the fallthrough marker"
    restore_pos = body.find("msgEl.value = _finalMsgWithInject")
    assert restore_pos > stale_if_end, \
        "composer restoration must be AFTER the stale-beat retry block (so non-stale-beat errors also restore)"


def test_retry_has_no_expected_beat_seq(chat_source):
    body = _ws_section(chat_source)
    # The original sendTurn in the TRY block (outside catch) has expectedBeatSeq, but the retry must NOT.
    # Find the retry section between stale-beat guard and its catch
    retry_start = body.find("stale-beat")
    retry_end = body.find("// ── Pre-stream refusal")
    retry_block = body[retry_start:retry_end]
    # Inside the retry's inner try block
    try_start = retry_block.find("await window.OrwellWs.sendTurn")
    if try_start != -1:
        # From there to the next });
        send_call_end = retry_block.find("});", try_start)
        send_call = retry_block[try_start:send_call_end + 3]
        assert "expectedBeatSeq:" not in send_call, \
            "retry sendTurn must not carry explicit expectedBeatSeq — sendTurn uses lastBeatSeq() as default"


def test_original_send_has_expected_beat_seq(chat_source):
    """Verify the outer try's sendTurn still carries the CAS token (regression guard)."""
    # The original try is just before the catch. Read from "try {" before catch.
    body = _ws_section(chat_source)
    # We can find the first sendTurn reference outside the catch
    # The original sendTurn is before catch
    idx = chat_source.find("expectedBeatSeq: (window.OrwellWs.lastBeatSeq && window.OrwellWs.lastBeatSeq()) || undefined")
    assert idx != -1, "the original sendTurn must still carry the expectedBeatSeq CAS token"


def test_retry_logs_double_failure(chat_source):
    body = _ws_section(chat_source)
    # The retry's catch must log the double-failure
    assert "console.warn(" in body, "retry catch must log the double-failure via console.warn"
    assert "#1878" in body, "retry catch log must reference issue #1878"

"""ORW-437 review fixes in frontend/static/js (source pins: the behaviours live in IIFEs a unit test cannot reach).
Each assertion fails on the code before the fix."""
import re
from pathlib import Path

JS = Path(__file__).resolve().parents[1] / "static" / "js"


def _chat() -> str:
    return (JS / "chat.js").read_text()


def test_stale_beat_retry_uses_the_reconnect_aware_send():
    # review of #2719: the stale-beat retry must wait for the socket like the first send.
    src = _chat()
    block = src[src.index('err.code === "stale-beat"'):]
    block = block[: block.index("stale-beat retry ALSO failed")]
    assert "sendTurnWhenLive" in block and "OrwellWs.sendTurn({" not in block


def test_zero_clock_bubble_clears_a_stale_in_world_moment():
    # review of #2662: with zero clocks and no moment on this beat, the seeded previous moment is cleared, not kept.
    src = _chat()
    fn = src[src.index("function _applyServerTimestamp"):]
    fn = fn[: fn.index("Sources box builder")]
    zero = fn[fn.index("if (_zeroClocks()) {"):]
    assert "span.textContent = ''" in zero and "role-timestamp-moment" in zero and "return;" in zero


def test_resolved_speaker_chip_is_keyboard_operable():
    # review of #2647: a resolved chip opens the dossier on click, so it is role=button + tabindex=0; an unresolved one stays an inert image.
    src = (JS / "markdown.js").read_text()
    assert re.search(r"rid \? ' role=\"button\" tabindex=\"0\"' : ' role=\"img\"'", src)


def _src(name):
    return (JS / name).read_text()


def test_ws_turn_flag_cleared_on_rejection_and_retry_backs_off():
    ws = _src("orwellWs.js")
    assert "pr.catch(function () { _ownTurnLive = false; })" in ws          # review of #2661
    assert "setTimeout(r, 100)" in ws and "sendFailures" in ws              # review of #2719: no microtask spin
    assert '_mode === "ws" && !!_sock && _sock.readyState !== 1' in ws       # review of #2719: a dead-but-not-yet-closed socket is reconnecting


def test_status_surfaces_small_fixes():
    assert "PENDING_MAX_MS" in _src("orwellReadCoalesce.js")                                   # #2684
    assert "_monoNow" in _src("orwellEngineStatus.js") and "Date.now" not in _src("orwellEngineStatus.js").split("_gapQuiet")[1][:300]   # #2719
    panel = _src("orwellStatusPanel.js")
    assert "!navigator.onLine" in panel and "stBeat !== stateBeat" in panel and "document.hidden" in panel   # #2719, #2648
    assert "All the houseguests have turned in" in _src("orwellNightStatus.js") and "if (state) _lastAwake = null" in _src("orwellNightStatus.js")   # #2678
    assert "else _chapterRows(id, [])" in _src("sessions.js")                                  # #2651
    assert "outerHTML" not in _src("orwellChapters.js").split("__guardTrigger")[1][:200]      # #2679
    assert "dataset.deliveryState = 'sending'" in _src("chatOutbox.js")                        # #2719

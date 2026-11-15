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

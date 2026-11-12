"""ORW-44 S4b: the WebSocket-only game build has no SSE mirror. A window that booted before the game was live finds the canonical
session over REST and nudges the socket to upgrade (OrwellWs.kick), instead of waiting for an SSE `run-started` invitation. Source pins
(the two-window behaviour is proved by the mirror-parity CI legs)."""
import re
from pathlib import Path

JS = Path(__file__).resolve().parents[1] / "static" / "js"


def _src(name):
    return (JS / name).read_text(encoding="utf-8")


def test_kick_only_upgrades_a_recoverable_fallback():
    ws = _src("orwellWs.js")
    m = re.search(r"kick: function \(\) \{(.*?)\n    \},", ws, re.S)
    assert m, "OrwellWs.kick missing"
    body = m.group(1)
    assert 'if (_mode !== "fallback") return false;' in body
    assert '"pregame-not-live"' in body and '"pertab-pending"' in body  # a blocked network (permanent cause) is never retried
    assert "_maybeUpgradeFromFallback()" in body


def test_session_sync_opens_no_event_source_in_the_ws_only_game_build():
    ss = _src("sessionSync.js")
    m = re.search(r"function connect\(id\) \{(.*?)try \{\s*es = new EventSource", ss, re.S)
    assert m and "if (wsOnlyGame()) return;" in m.group(1), "connect() must refuse the SSE mirror in the WS-only game build"
    assert "gameBuildOn() && !!(window.OrwellWs && window.OrwellWs.flagOn" in ss


def test_canonical_resolution_kicks_the_socket():
    ss = _src("sessionSync.js")
    assert "if (_canon.id && wsOnlyGame()) {" in ss and "window.OrwellWs.kick()" in ss


def test_a_window_with_no_session_converges_onto_the_canonical_one_before_the_kick():
    ss = _src("sessionSync.js")
    assert "if (!currentSession()) { convergeView(_cid).then(_kick); } else { _kick(); }" in ss

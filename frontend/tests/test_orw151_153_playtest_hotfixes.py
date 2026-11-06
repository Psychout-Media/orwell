"""Playtest hotfixes, 11-06 (cards ORW-141, ORW-143, ORW-151, ORW-152, ORW-153).

ORW-141's real-browser layout test lives in test_orw141_speaker_line_browser.py (browser lane).
ORW-151: the room strip lagged a turn behind (frozen turn-start snapshot); progression turns now
fall back to live, and only the newest strip refresh may render.
ORW-152: GET /api/fonts/custom must never create directories (500 on a read-only code tree).
ORW-153: the saved reply must not glue agent rounds together.
ORW-143: the headshot 4 s poll skips hidden tabs and never stacks requests.
"""
import os

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(*rel):
    with open(os.path.join(FRONTEND, *rel), encoding="utf-8") as f:
        return f.read()


def test_orw151_progression_turn_drops_the_frozen_room_snapshot():
    src = _read("src", "agent_loop.py")
    i = src.index("_chf.freeze_mark_model_moved(owner)")
    guard = src[src.rindex("if ", 0, i):i]
    assert "_npc_moved" in guard and "_progressed" in guard, guard
    assert '"advanceGame"' in src[src.index("_PROGRESSION_TOOLS = {"):][:80]


def test_orw151_room_strip_only_newest_tick_renders():
    js = _read("static", "js", "orwellRoomStrip.js")
    tick = js[js.index("async function tick()"):]
    tick = tick[:tick.index("\n  }\n")]
    assert "const mySeq = ++_tickSeq;" in tick
    # every render() in the tick is preceded by a supersession check
    assert tick.count("if (superseded()) return;") >= 4
    assert tick.index("if (superseded()) return;") < tick.index("render(")


def test_orw152_custom_fonts_never_creates_directories(tmp_path):
    pytest.importorskip("fastapi")
    from routes import font_routes
    missing = tmp_path / "nope" / "custom"
    assert font_routes.list_custom_font_families(str(missing)) == {}
    assert not missing.exists()  # read-only by design: no makedirs
    have = tmp_path / "fonts"
    have.mkdir()
    (have / "JetBrainsMono-Regular.woff2").write_bytes(b"x")
    (have / "notes.txt").write_text("ignored")
    fams = font_routes.list_custom_font_families(str(have))
    assert list(fams) == ["JetBrains Mono"]
    assert "makedirs" not in _read("routes", "font_routes.py").split("def setup_font_routes")[1]


def test_orw153_saved_reply_separates_agent_rounds():
    src = _read("routes", "chat_routes.py")
    i = src.index('if data.get("type") == "agent_step":')
    branch = src[i:i + 1200]
    assert 'full_response += "\\n\\n"' in branch
    assert 'if full_response and not full_response.endswith(("\\n", " "))' in branch


def test_orw143_headshot_poll_skips_hidden_tabs_and_in_flight_routes():
    js = _read("static", "js", "orwellHeadshot.js")
    i = js.index("setInterval(async function ()")
    loop = js[i:i + 400]
    assert "document.hidden || _routeInFlight" in loop
    assert "finally { _routeInFlight = false; }" in loop

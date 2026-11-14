"""ORW-343 (Ryne audit card 17): the cast card shows each houseguest's mood WORD as the player last saw it. The engine sends `lastSeenMood` on an active houseguest's card (a short string, never a number or a cause);
the roster route carries it through only when it is a short string; the cast tile renders it in a small row and renders nothing when it is absent. Node runs the real `setMood` source; no DOM is needed."""
import importlib
import json
import pathlib
import re
import shutil
import subprocess

import pytest

JS = pathlib.Path(__file__).resolve().parents[1] / "static" / "js" / "orwellCast.js"
SRC = JS.read_text(encoding="utf-8")


def _set_mood_source() -> str:
    m = re.search(r"  function setMood\(row, word\) \{.*?\n  \}\n", SRC, re.S)
    assert m, "setMood is defined in orwellCast.js"
    return m.group(0)


def _render(word):
    """Run the real setMood against a tiny element stub; return what a tile would show."""
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    prog = "const el={textContent:'',hidden:true,title:''};" + _set_mood_source() + f"setMood(el,{json.dumps(word)});console.log(JSON.stringify(el));"
    out = subprocess.run([node, "-e", prog], capture_output=True, text=True, check=True).stdout.strip()
    return json.loads(out)


def test_a_word_renders_with_a_last_seen_hover():
    el = _render("tense, on edge")
    assert el["textContent"] == "tense, on edge" and el["hidden"] is False and el["title"] == "Last seen: tense, on edge"


@pytest.mark.parametrize("bad", [None, "", "   ", 7, {"x": 1}, ["tense"], "x" * 41])
def test_nothing_renders_without_a_short_word(bad):
    el = _render(bad)
    assert el["textContent"] == "" and el["hidden"] is True and el["title"] == "", "absent (or not a short word) => no row, nothing invented"


def test_the_tile_adopts_the_row_and_refreshes_it():
    assert 'moodEl.className = "oc-mood";' in SRC and "setMood(moodEl, hg.lastSeenMood);" in SRC and "card.appendChild(moodEl);" in SRC
    assert "if (entry.moodEl) setMood(entry.moodEl, hg.lastSeenMood);" in SRC, "a roster refresh updates the word, and clears it when it goes absent"


def test_the_roster_route_carries_only_a_short_string_word():
    routes = importlib.import_module("routes.orwell_routes")
    state = {
        "player": {"id": "player", "name": "P", "lastSeenMood": "should never ride the player card"},
        "house": [
            {"id": "npc:1", "name": "A", "status": "active", "lastSeenMood": "buoyant"},
            {"id": "npc:2", "name": "B", "status": "active"},
            {"id": "npc:3", "name": "C", "status": "active", "lastSeenMood": 0.7},
            {"id": "npc:4", "name": "D", "status": "active", "lastSeenMood": "x" * 41},
        ],
    }
    cards = {c["id"]: c for c in routes._roster_cards(state, None)}
    assert cards["npc:1"]["lastSeenMood"] == "buoyant"
    assert "lastSeenMood" not in cards["npc:2"], "absent stays absent (flag off or never seen: byte-identical card)"
    assert "lastSeenMood" not in cards["npc:3"] and "lastSeenMood" not in cards["npc:4"], "a number or a long string never passes"
    assert "lastSeenMood" not in cards["player"], "the player's own card never carries a cue"

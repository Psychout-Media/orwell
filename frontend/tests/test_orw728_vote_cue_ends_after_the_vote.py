"""ORW-728 (Season 2 playtest W1-11): after the player voted, the status panel still read "You vote tonight" (the phase stays "eviction" through the staged reveal). The voter cue now shows only while the player's own
eviction-vote decision is the pending one. Runs the panel's real `seatHint` function under node. Roles only."""
import json
import os
import re
import subprocess

import pytest

JS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static", "js", "orwellStatusPanel.js")


def _hint(status, state):
    src = open(JS, encoding="utf-8").read()
    m = re.search(r"  function seatHint\(status, state\) \{.*?\n  \}\n", src, re.S)
    assert m, "seatHint not found"
    code = m.group(0) + f"\nconsole.log(JSON.stringify(seatHint({json.dumps(status)}, {json.dumps(state)})));"
    try:
        out = subprocess.run(["node", "-e", code], capture_output=True, text=True, timeout=30)
    except FileNotFoundError:
        pytest.skip("node not installed")
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


ME = {"player": {"id": "p1", "status": "active"}}
BASE = {"phase": "eviction", "hoh": {"id": "h1"}, "nominees": [{"id": "n1"}, {"id": "n2"}]}


def test_the_cue_shows_while_the_players_vote_is_open():
    assert _hint({**BASE, "pending": {"kind": "eviction-vote"}}, ME) == "You vote tonight"


def test_the_cue_is_gone_once_the_player_has_voted():
    assert _hint({**BASE, "pending": None}, ME) == ""
    assert _hint({**BASE, "pending": {"kind": "ceremony-step"}}, ME) == ""


def test_the_other_cues_are_unchanged():
    assert _hint({**BASE, "hoh": {"id": "p1"}}, ME) == "You break ties"
    assert _hint({**BASE, "nominees": [{"id": "p1"}, {"id": "n2"}]}, ME) == "The House votes on you"
    assert _hint({**BASE, "phase": "nominations", "pending": {"kind": "eviction-vote"}}, ME) == ""

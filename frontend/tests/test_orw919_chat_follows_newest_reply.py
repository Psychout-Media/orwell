"""ORW-919 (Fable week-1 playtest): the chat did not scroll to the newest reply. ui.js gave up following whenever the bottom was more than 300px away, reading that as the
player scrolling up, but a reply that lands in one big block opens the same gap with nobody touching anything. Only the player's own scroll-up now unpins the view
(static/js/chatFollow.js); content growth never does. Driven in node with a fake box; ui.js is pinned to use it."""
import json
import pathlib
import shutil
import subprocess

import pytest

FE = pathlib.Path(__file__).resolve().parent.parent
UI = (FE / "static" / "js" / "ui.js").read_text()


@pytest.mark.skipif(shutil.which("node") is None, reason="needs node")
def test_follow_survives_a_big_block_and_only_the_player_unpins():
    r = subprocess.run(["node", str(FE / "tests" / "js" / "orw919_follow_harness.mjs"), str(FE / "static" / "js")], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout.strip().splitlines()[-1])
    assert out == {"followsABigBlock": True, "playerScrolledUpUnpins": True, "staysUnpinnedWhileReading": True, "backAtBottomRepins": True,
                   "ourStepMidwayStaysPinned": True}, out


def test_ui_uses_the_follow_state_not_the_300px_guess():
    assert "diff > 300" not in UI, "a big block of new content is not the player scrolling up"
    assert "createFollow" in UI and "shouldFollow()" in UI and "noteSet(" in UI

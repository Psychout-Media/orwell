"""ORW-650 — watching from the couch, front-end rendering. Roles only.

The engine adds `watching: { moments: string[] }` to the player-facing game state for a pre-jury evictee in watch mode.
This pins: (1) the field survives the FE's get_game_state projection and the model-facing result redaction;
(2) the status panel renders it verbatim as a labelled real list, hidden when absent; (3) it only LISTENS for
`orwell:gamechanged` (the g15 single-dispatcher rule); (4) the pure moment filter, run under node.
"""
import json
import os
import re
import shutil
import subprocess
import tempfile

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_NODE = shutil.which("node")


def _read(*rel):
    with open(os.path.join(FRONTEND, *rel), encoding="utf-8") as f:
        return f.read()


PANEL = _read("static", "js", "orwellStatusPanel.js")


def test_watching_survives_the_model_facing_tool_result():
    from src.tool_execution import redact_player_producer_fields
    view = {"player": {"status": "evicted", "spectator": "watch", "story": "x"}, "watching": {"moments": ["a", "b"]}}
    out = redact_player_producer_fields(view)
    assert out["watching"] == {"moments": ["a", "b"]}
    assert "story" not in out["player"]


def test_get_game_state_tool_returns_the_field_to_the_agent(monkeypatch):
    import asyncio
    from src import orwell_engine, tool_implementations as ti
    view = {"player": {"status": "evicted"}, "watching": {"moments": ["one", "two"]}}

    async def fake(user=None, timeout=None):
        return view
    monkeypatch.setattr(orwell_engine, "get_game_state", fake)
    res = asyncio.run(ti.do_get_game_state("", owner="u"))
    assert res["exit_code"] == 0
    assert json.loads(res["output"])["watching"]["moments"] == ["one", "two"]


def test_panel_renders_a_labelled_real_list_hidden_by_default():
    assert re.search(r'<section class="os-couch" id="os-couch" hidden aria-labelledby="os-couch-h">', PANEL)
    assert '<ol class="os-couch-list" id="os-couch-list">' in PANEL
    assert "renderCouch(el, state)" in PANEL
    # verbatim: textContent only, never innerHTML, and no fixed player-facing sentence per case
    body = PANEL[PANEL.index("function renderCouch("):PANEL.index("// The head-count tally")]
    assert "innerHTML" not in body and "textContent = m" in body


def test_panel_only_listens_for_gamechanged():
    assert not re.search(r"new CustomEvent\(['\"]orwell:gamechanged", PANEL)
    assert 'addEventListener("orwell:gamechanged"' in PANEL


def _run_filter(state):
    start = PANEL.index("function couchMoments(")
    end = PANEL.index("// Heading composed")
    src = PANEL[start:end]
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "t.js")
        with open(path, "w") as f:
            f.write(src + "\nconsole.log(JSON.stringify(couchMoments(%s)));" % json.dumps(state))
        out = subprocess.run([_NODE, path], capture_output=True, text=True, timeout=20)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_moment_filter_keeps_engine_strings_in_order_and_hides_when_absent():
    assert _run_filter({"watching": {"moments": [" first ", "second"]}}) == ["first", "second"]
    assert _run_filter({"watching": {"moments": ["", 3, None, "kept"]}}) == ["kept"]
    assert _run_filter({"player": {"status": "active"}}) == []   # active player / skip / juror: field absent
    assert _run_filter({"watching": {"moments": "nope"}}) == []
    assert _run_filter(None) == []

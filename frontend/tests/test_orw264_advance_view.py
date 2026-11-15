"""ORW-264 (R2 / ADR 0015): the advanceGame/submitDecision tool-result parse (decision-card arming `orwell:pending`
+ chyron announcements) is ONE pure function, `orwellAdvanceView` (orwellToolBeats.js), used by BOTH the live stream
(chat.js) and the reload path (chatRenderer.js storedAnnouncements). Roles only."""
import json
import os
import shutil
import subprocess

import pytest

STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "js")


def _read(name):
    with open(os.path.join(STATIC, name), encoding="utf-8") as f:
        return f.read()


def _views(cases):
    node = shutil.which("node")
    if not node:
        pytest.skip("node not available")
    mod = os.path.join(STATIC, "orwellToolBeats.js").replace("\\", "/")
    script = (
        f"import {{ orwellAdvanceView }} from 'file://{mod}';\n"
        f"const cases = {json.dumps(cases)};\n"
        "process.stdout.write(JSON.stringify(cases.map(c => orwellAdvanceView(c[0], c[1]))));\n"
    )
    p = subprocess.run([node, "--input-type=module", "-e", script], capture_output=True, text=True, timeout=30)
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)


def test_parse_shapes():
    pend = {"pending": {"kind": "vote"}, "announcements": [{"id": "a"}]}
    out = _views([
        ["advanceGame", json.dumps(pend)],
        ["submitDecision", ""],
        ["submitDecision", "null"],
        ["advanceGame", "{not json"],
        ["getGameState", json.dumps(pend)],
    ])
    assert out[0] == pend
    assert out[1] == {}
    assert out[2] == {}
    assert out[3] is None
    assert out[4] is None


def test_both_paths_use_the_shared_parse():
    live, reload_ = _read("chat.js"), _read("chatRenderer.js")
    assert "orwellAdvanceView(json.tool, json.output)" in live
    assert "orwellAdvanceView(ev.tool, ev.output)" in reload_
    assert "const _adv = JSON.parse(" not in live
    assert "JSON.parse(ev.output)" not in reload_

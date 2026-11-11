"""ORW-264 (R2 / ADR 0015): the finished tool-beat chip is built by ONE pure function, `orwellBeatNodeView`
(orwellToolBeats.js), that BOTH the live stream (chat.js) and the reload path (chatRenderer.js) call.
BEHAVIORAL: the real function is run in Node; STRUCTURAL: neither path hand-builds the chip any more.
Roles only."""
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
        f"import {{ orwellBeatNodeView }} from 'file://{mod}';\n"
        f"const cases = {json.dumps(cases)};\n"
        "const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');\n"
        "process.stdout.write(JSON.stringify(cases.map(c => orwellBeatNodeView({...c, esc}))));\n"
    )
    p = subprocess.run([node, "--input-type=module", "-e", script], capture_output=True, text=True, timeout=30)
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)


EVICT = json.dumps({"event": {"beat": "eviction", "content": "An evictee is evicted"}, "evictionVotes": {"evict": 7, "stay": 1}})


def test_golden_chip_shapes():
    out = _views([
        {"tool": "advanceGame", "beat": "PRODUCTION", "ok": False, "output": "{}", "expandHtml": ""},
        {"tool": "someTool", "beat": None, "ok": True, "output": "x", "expandHtml": "<pre>cmd</pre>"},
        {"tool": "someTool", "beat": None, "ok": True, "output": "x", "expandHtml": "<pre>cmd</pre>", "wasOpen": True},
        {"tool": "<b>", "beat": None, "ok": False, "output": "x", "expandHtml": ""},
    ])
    assert out[0]["className"] == "agent-thread-node error agent-thread-node--flat"
    assert '<span class="agent-thread-status">failed</span>' in out[0]["innerHTML"]
    assert "PRODUCTION" in out[0]["innerHTML"]
    assert out[1]["className"] == "agent-thread-node"
    assert "agent-thread-chevron" in out[1]["innerHTML"]
    assert '<div class="agent-thread-content"><pre>cmd</pre></div>' in out[1]["innerHTML"]
    assert out[2]["className"] == "agent-thread-node open"  # the live-only open state is an INPUT
    assert "&lt;b>" in out[3]["innerHTML"]  # escaped


def test_live_and_reload_inputs_differ_only_by_transients():
    base = {"tool": "advanceGame", "beat": "PRODUCTION", "ok": True, "output": EVICT, "expandHtml": ""}
    live, reload = _views([dict(base, reveal=True), dict(base)])
    assert live["innerHTML"] == reload["innerHTML"]
    assert live["outcome"] == reload["outcome"]
    assert live["className"].replace(" ow-ceremony-reveal", "") == reload["className"]


def test_both_paths_delegate_and_no_longer_hand_build_the_chip():
    for src in (_read("chat.js"), _read("chatRenderer.js")):
        assert "orwellBeatNodeView(" in src
        assert "agent-thread-chevron" not in src, "the chip's chevron markup must live only in the shared builder"
        assert 'agent-thread-status">${ok' not in src, "the status tail must live only in the shared builder"

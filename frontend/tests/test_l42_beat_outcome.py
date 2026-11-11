"""L42 — inter-message beat markers carry the PUBLIC outcome, not a generic "done".

Live feedback (docs/audits/2026-06-19-live-debug-issues.md, L42): the chat's tool-beat
markers read as a stack of identical "PRODUCTION done" / "YOUR MOVE done" rows that say
nothing about WHAT happened. Each solidified beat should instead carry the actual PUBLIC
outcome derived from the tool RESULT (all player-witnessed, Vault-free) — e.g. an
advanceGame that resolved an eviction → "🗳️ Troy is evicted (7-1)", an HOH comp → the
winner, nominations → the two names.

Two halves:
  * BEHAVIORAL — the real JS `orwellBeatOutcome` is executed in Node over sample tool
    results (the single source of truth both render paths import).
  * STRUCTURAL — both the live (chat.js) and reload (chatRenderer.js) paths call it and
    render the outcome in place of the generic status.
"""

import json
import os
import shutil
import subprocess

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC = os.path.join(FRONTEND, "static", "js")


def _read(*parts):
    with open(os.path.join(FRONTEND, *parts), encoding="utf-8") as f:
        return f.read()


def _node_outcomes(cases):
    """Execute the real orwellBeatOutcome() in Node over (tool, output) cases."""
    node = shutil.which("node")
    if not node:
        pytest.skip("node not available for the behavioral beat-outcome check")
    mod = os.path.join(STATIC, "orwellToolBeats.js").replace("\\", "/")
    payload = json.dumps(cases)
    script = (
        f"import {{ orwellBeatOutcome }} from 'file://{mod}';\n"
        f"const cases = {payload};\n"
        "const out = cases.map(c => orwellBeatOutcome(c[0], c[1]));\n"
        "process.stdout.write(JSON.stringify(out));\n"
    )
    proc = subprocess.run(
        [node, "--input-type=module", "-e", script],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, f"node failed: {proc.stderr}"
    return json.loads(proc.stdout)


def test_l42_outcome_reads_the_public_beat_result():
    nominations = json.dumps({"event": {"beat": "nominations", "content": "Maya nominates Cole and Jess"}})
    hoh = json.dumps({"event": {"beat": "hoh-competition", "content": "Maya wins Head of Household"}})
    eviction = json.dumps({
        "event": {"beat": "eviction", "content": "Troy is evicted"},
        "eviction": {"stage": "result", "votesRevealed": [
            {"votedFor": {"name": "Troy"}}, {"votedFor": {"name": "Troy"}},
            {"votedFor": {"name": "Troy"}}, {"votedFor": {"name": "Troy"}},
            {"votedFor": {"name": "Troy"}}, {"votedFor": {"name": "Troy"}},
            {"votedFor": {"name": "Troy"}}, {"votedFor": {"name": "Jess"}},
        ]},
    })
    winner = json.dumps({"finished": True, "winner": {"name": "Maya"}, "event": {"beat": "finale-result", "content": "x"}})
    out = _node_outcomes([
        ["advanceGame", nominations],
        ["submitDecision", hoh],
        ["advanceGame", eviction],
        ["advanceGame", winner],
    ])
    assert out[0] == "🔨 Maya nominates Cole and Jess"
    assert out[1] == "🏆 Maya wins Head of Household"
    # the anonymized ballot tally is appended (E12: ballots, never voters)
    assert out[2] == "🗳️ Troy is evicted (7-1)"
    # a crowned winner trumps everything
    assert out[3] == "👑 Maya wins the season"


def test_l42_outcome_is_null_when_there_is_nothing_public_to_say():
    out = _node_outcomes([
        ["recordInteraction", json.dumps({"ok": True})],     # no resolved beat
        ["gameStatus", ""],                                   # empty output
        ["advanceGame", "not json"],                          # unparseable
        ["advanceGame", json.dumps({"pending": {"kind": "nominations"}})],  # blocked, no event
    ])
    assert out == [None, None, None, None]


def test_l42_both_render_paths_use_the_outcome():
    chat = _read("static", "js", "chat.js")
    renderer = _read("static", "js", "chatRenderer.js")
    # both import the single-source deriver
    assert "orwellBeatOutcome" in chat
    assert "orwellBeatOutcome" in renderer
    # live path: the outcome replaces the generic "done" status when present
    # (ORW-264: the outcome-or-beat-or-tool text now lives in the ONE shared orwellBeatNodeView builder)
    assert "orwellBeatNodeView({ tool: json.tool" in chat
    # reload path: same treatment so a re-opened transcript reads the same
    assert "orwellBeatNodeView({ tool: ev.tool" in renderer
    tb = _read("static", "js", "orwellToolBeats.js")
    assert "orwellBeatOutcome(tool, output)" in tb and "outcome || beat || tool" in tb


def test_l42_outcome_is_vault_free_by_construction():
    """The deriver only ever reads public beat fields (event.content, winner.name, and the
    anonymized ballot COUNT). It must never reach for a hidden field — no lean/tally/script
    /soul/secret token appears in the source."""
    js = _read("static", "js", "orwellToolBeats.js")
    start = js.index("export function orwellBeatOutcome")
    body = js[start:start + 1400]
    for banned in ["lean", "secret", "soul", "trust", "affinity", "threat", "script", "hidden"]:
        assert banned not in body, f"L42 deriver must not read a hidden field ({banned!r})"

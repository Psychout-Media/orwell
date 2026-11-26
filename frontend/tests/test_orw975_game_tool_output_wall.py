"""ORW-975 (Vault Wall, wall audit 3d): every engine game tool's output reaches the page as a CLOSED copy, not only advanceGame / submitDecision (ORW-964). Before, makeDeal, confide, confront, recordInteraction,
runCompetition, createCharacter, seasonRetrospective and the rest handed the page their raw engine result as the tool event's `output` (live, stored, mirrored), cut at 2,000 characters. The page reads only `beatSeq` and
`correction` off a mutating tool, `started` / `createRefused` off createCharacter, and the beat chip's outcome line. Layers: planted sentinels across every non-silent game tool with a positive control; an
unknown key at every level of the shape is dropped; the page's own parsers give the identical answer on the raw output and the closed one; and the long-output `beatSeq` bug (a 2,000-character cut is not JSON). Roles only."""
from __future__ import annotations

import importlib
import json
import pathlib
import subprocess

import pytest

agent_loop = importlib.import_module("src.agent_loop")
tool_schemas = importlib.import_module("src.tool_schemas")
orwell_routes = importlib.import_module("routes.orwell_routes")
S = "ZZ-sentinel-975"
SHAPE = orwell_routes._BROWSER_GAME_TOOL_SHAPE
JS = pathlib.Path(__file__).resolve().parents[1] / "static" / "js" / "orwellToolBeats.js"
# the engine game tools whose output the page may show: the game keep-set minus the silent read tools (their output is blank already, #1871) and the two advance tools (ORW-964)
GAME_TOOLS = sorted(t for t in tool_schemas.ORWELL_GAME_TOOLS if t not in agent_loop._ORWELL_SILENT_TOOLS and t not in agent_loop._BROWSER_PROJECTED_TOOLS)


def _ref(n="Role One", i="npc:1"):
    return {"id": i, "name": n}


def _raw(**over):
    base = {"beatSeq": 52, "correction": None, "accepted": True, "disclosed": True, "content": "Role Two told you: " + S, "confidence": 0.31, "trust": S, "threat": S, "hiddenReason": S, "plan": {"target": S},
            "deal": {"id": "d1", "parties": [dict(_ref(), loyalty=S)], "plannedBreak": S}, "kind": "safety", "terms": "keep each other safe", "why": S}
    base.update(over)
    return base


def _out(tool, payload):
    return agent_loop._browser_tool_output(tool, {"output": json.dumps(payload), "exit_code": 0})


def test_the_set_under_test_is_the_non_silent_game_tools():
    assert len(GAME_TOOLS) >= 20 and {"makeDeal", "confide", "confront", "recordInteraction", "runCompetition", "createCharacter", "seasonRetrospective"} <= set(GAME_TOOLS)
    assert "getGameState" not in GAME_TOOLS and "advanceGame" not in GAME_TOOLS


def test_positive_control_the_raw_result_carries_every_planted_field():
    assert json.dumps(_raw()).count(S) >= 6


@pytest.mark.parametrize("tool", GAME_TOOLS)
def test_no_planted_field_reaches_the_page_from_any_game_tool(tool):
    out = _out(tool, _raw())
    assert isinstance(out, str), tool
    assert S not in out and "0.31" not in out, f"{tool}: a planted field survived"
    body = json.loads(out)
    assert body == {"beatSeq": 52, "correction": None}, f"{tool}: only beatSeq and correction of this result are read by the page: {body}"


def test_every_dict_level_of_the_game_tool_shape_is_closed():
    def fill(spec):
        if spec is True:
            return "v"
        if isinstance(spec, dict):
            d = {k: fill(s) for k, s in spec.items()}
            d["zzUnknownKey"] = S
            return d
        return [fill(spec[0])]
    full = {k: fill(s) for k, s in SHAPE.items()}
    full["zzUnknownTop"] = S
    out = orwell_routes._project_for_browser(full, SHAPE)
    assert S not in json.dumps(out) and "zzUnknown" not in json.dumps(out)


def test_a_long_result_no_longer_loses_beatSeq_to_the_two_thousand_character_cut():
    big = _raw(narration=("x" * 5000), roster=[{"id": f"npc:{i}", "name": f"Role {i}", "note": S} for i in range(60)])
    assert len(json.dumps(big)) > 6000
    out = _out("makeDeal", big)
    assert json.loads(out)["beatSeq"] == 52 and S not in out and len(out) < 200  # valid JSON the page can parse (the old copy was cut mid-string: no beatSeq, the G15 dispatcher read undefined)


def test_a_failed_call_or_a_non_json_output_leaves_nothing_and_a_non_game_tool_is_untouched():
    assert agent_loop._browser_tool_output("makeDeal", {"error": "refused: " + S}) == ""
    assert agent_loop._browser_tool_output("confide", {"output": "plain text " + S}) == ""
    assert agent_loop._browser_tool_output("confide", {"output": json.dumps([S])}) == ""
    assert agent_loop._browser_tool_output("bash", {"output": S}) is None
    assert agent_loop._browser_tool_output("getGameState", {"output": S}) is None  # a silent read tool: blanked elsewhere (#1871)


def _page(outputs):
    script = f"""
import {{ orwellBeatOutcome }} from {json.dumps(JS.as_uri())};
const outs = JSON.parse(await new Promise((r) => {{ let d = ''; process.stdin.on('data', (c) => d += c); process.stdin.on('end', () => r(d)); }}));
console.log(JSON.stringify(outs.map((o) => {{
  let p = {{}}; try {{ p = JSON.parse(o) || {{}}; }} catch (_) {{}}
  return {{ outcome: orwellBeatOutcome('runCompetition', o), beatSeq: p.beatSeq, correction: p.correction || null, started: !!p.started, refused: !!p.createRefused }};
}})));
"""
    p = subprocess.run(["node", "--input-type=module", "-e", script], input=json.dumps(outputs), capture_output=True, text=True, timeout=60)
    assert p.returncode == 0, p.stderr[-800:]
    return json.loads(p.stdout)


def test_the_pages_own_readers_answer_identically_on_the_raw_and_the_closed_output():
    cases = [
        ("runCompetition", _raw(event={"beat": "hoh-competition", "content": "Role Two wins Head of Household", "participants": [dict(_ref("Role Two", "npc:2"), x=S)], "why": S})),
        ("runCompetition", _raw(finished=True, winner=dict(_ref(), secret=S))),
        ("createCharacter", _raw(started=True, createRefused=None)),
        ("createCharacter", _raw(started=False, createRefused="casting-incomplete", missing=["archetype"])),
        ("makeDeal", _raw(correction="the control room reviewed the tape")),
        ("confide", _raw()),
    ]
    raw = [json.dumps(p) for _, p in cases]
    closed = [_out(t, p) for t, p in cases]
    a, b = _page(raw), _page(closed)
    for (t, _), x, y in zip(cases, a, b):
        assert x == y, f"{t}: the page reads something the closed shape dropped\nraw={x}\nclosed={y}"
    assert a[0]["outcome"] and a[1]["outcome"].startswith("\U0001F451") and a[2]["started"] and a[3]["refused"] and a[4]["correction"] and a[5]["beatSeq"] == 52


def test_the_agent_loop_still_applies_it_to_the_emitted_and_the_stored_copy():
    import inspect
    src = inspect.getsource(agent_loop)
    i = src.index("_closed_output = _browser_tool_output(block.tool_type, result)")
    assert "output_text = _closed_output" in src[i:i + 200]

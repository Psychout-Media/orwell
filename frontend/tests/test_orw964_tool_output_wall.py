"""ORW-964 (Vault Wall, part 3b): the model's advanceGame / submitDecision call hands the page the engine's whole advance view as the tool event's `output` (the live tool_output, the stored copy on reload, the WS
mirror). It is now the closed shape `_BROWSER_TOOL_ADVANCE_SHAPE`: only what the page reads. Proof in three layers: (1) planted sentinels in every class of an engine advance result, with a positive control that the
raw result carries them; (2) allowlist-by-construction (an unknown key at EVERY dict level is dropped); (3) the page's OWN parsers (orwellBeatOutcome, orwellCeremonySlate, orwellAdvanceView, run under node) give the
IDENTICAL answer on the raw output and on the closed one, for every beat kind they handle, so nothing the page reads was dropped. Roles only."""
from __future__ import annotations

import importlib
import json
import pathlib
import subprocess

import pytest

agent_loop = importlib.import_module("src.agent_loop")
orwell_routes = importlib.import_module("routes.orwell_routes")
S = "ZZ-sentinel-964"
SHAPE = orwell_routes._BROWSER_TOOL_ADVANCE_SHAPE
JS = pathlib.Path(__file__).resolve().parents[1] / "static" / "js" / "orwellToolBeats.js"


def _ref(n="Role One", i="npc:1"):
    return {"id": i, "name": n}


def _raw(beat="eviction", content="Role One is evicted", **over):
    base = {
        "beatSeq": 41, "finished": False, "correction": None,
        "event": {"beat": beat, "content": content, "participants": [dict(_ref(), trust=S), _ref("Role Two", "npc:2"), _ref("Role Three", "npc:3")], "consequence": {"fold": S}, "why": S},
        "status": {"week": 3, "phase": "eviction", "veto": {"holder": dict(_ref("Role Two", "npc:2"), edge=S), "used": False, "plannedDecision": S}, "flavourSeed": {"note": S}, "owedFavors": [{"id": S}]},
        "eviction": {"stage": "result", "evictee": _ref(), "nominees": [_ref()], "votesRevealed": [{"votedFor": dict(_ref(), lean=S), "voter": S}, {"votedFor": _ref(), "voter": S}, {"votedFor": _ref("Role Two", "npc:2")}],
                     "voteBeat": {"sealed": True, "ballotSeq": 4, "voter": S}, "tally": S},
        "announcements": [{"id": "a1", "kind": "eviction-result", "week": 3, "beatSeq": 41, "headline": "Role One is evicted.", "subjects": [dict(_ref(), trust=S)], "detail": {"votes": {"evict": 9, "keep": 4}, "secret": S}}],
        "pending": {"kind": "ceremony-step", "text": "The votes are read", "ceremony": {"kind": "eviction", "step": 2, "of": 5, "stepId": S}, "by": dict(_ref(), loyalty=S), "stances": [S]},
        "voteBeatCue": True, "plannedOutcome": S, "tally": S, "vetoDrawBeat": {"step": "field", "players": [_ref()], "plan": S},
    }
    base.update(over)
    return base


CASES = {
    "eviction": _raw(),
    "hoh": _raw(beat="hoh-competition", content="Role Two wins Head of Household", event={"beat": "hoh-competition", "content": "Role Two wins Head of Household", "participants": [dict(_ref("Role Two", "npc:2"), x=S)], "why": S}),
    "nominations": _raw(beat="nominations", content="Role Two nominates Role One and Role Three"),
    "veto-ceremony": _raw(beat="veto-ceremony", content="Role Two uses the veto on Role One"),
    "veto-comp": _raw(beat="veto-competition", content="Role Two wins the Power of Veto"),
    "comp-round": _raw(beat="comp-elimination", content="Role Three is out; 5 remain"),
    "crowned": _raw(beat="finale-result", content="Role One wins", finished=True, winner=dict(_ref(), secret=S)),
    "no-event": {"beatSeq": 9, "pending": None, "plannedOutcome": S},
    "corrected": _raw(correction="the control room reviewed the tape"),
}


def _out(result_output):
    return agent_loop._browser_tool_output("advanceGame", {"output": json.dumps(result_output), "exit_code": 0})


def _paths(v, p=""):
    out = set()
    if isinstance(v, dict):
        for k, x in v.items():
            out |= _paths(x, f"{p}.{k}" if p else k)
    elif isinstance(v, list):
        for x in v:
            out |= _paths(x, p + "[]")
        if not v:
            out.add(p + "[]*")
    else:
        out.add(p)
    return out


def test_positive_control_the_raw_results_carry_every_planted_field():
    assert sum(json.dumps(r).count(S) for r in CASES.values()) >= 40


@pytest.mark.parametrize("name", sorted(CASES))
def test_no_planted_field_reaches_the_page(name):
    out = _out(CASES[name])
    assert isinstance(out, str) and out, name
    assert S not in out, f"{name}: a planted field survived"
    for gone in ("plannedOutcome", "tally", "consequence", "why", "voter", "flavourSeed", "owedFavors", "stances", "plan"):
        assert f'"{gone}"' not in out, f"{name}: {gone}"


def test_every_dict_level_of_the_tool_shape_is_closed():
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


def test_only_the_two_advance_tools_are_projected_and_a_bad_output_fails_closed():
    assert agent_loop._browser_tool_output("makeDeal", {"output": json.dumps({"x": S})}) is None
    assert agent_loop._browser_tool_output("advanceGame", {"output": "not json " + S}) == ""
    assert agent_loop._browser_tool_output("submitDecision", {"output": json.dumps([S])}) == ""
    assert agent_loop._browser_tool_output("advanceGame", {"error": "engine refused: " + S}) == ""
    assert agent_loop._browser_tool_output("advanceGame", {"output": ""}) is None


def _page(outputs):
    """The page's own parsers, under node, on each output: the beat chip's outcome line, the ceremony slate descriptor, and the keys the stream handler reads off the advance view."""
    script = f"""
import {{ orwellBeatOutcome, orwellCeremonySlate, orwellAdvanceView }} from {json.dumps(JS.as_uri())};
const outs = JSON.parse(await new Promise((r) => {{ let d = ''; process.stdin.on('data', (c) => d += c); process.stdin.on('end', () => r(d)); }}));
const res = outs.map((o) => {{
  const adv = orwellAdvanceView('advanceGame', o) || {{}};
  let parsed = {{}}; try {{ parsed = JSON.parse(o) || {{}}; }} catch (_) {{}}
  return {{ outcome: orwellBeatOutcome('advanceGame', o), slate: ((s) => s && Object.assign({{}}, s, {{ subjects: s.subjects.map((x) => [x.id, x.name]) }}))(orwellCeremonySlate('advanceGame', o)), pendingKind: adv.pending ? adv.pending.kind : null,
           announcements: (adv.announcements || []).map((a) => [a.id, a.kind, a.headline]), beatSeq: parsed.beatSeq, correction: parsed.correction || null,
           finished: !!parsed.finished, winner: parsed.winner ? parsed.winner.name : null }};
}});
console.log(JSON.stringify(res));
"""
    p = subprocess.run(["node", "--input-type=module", "-e", script], input=json.dumps(outputs), capture_output=True, text=True, timeout=60)
    assert p.returncode == 0, p.stderr[-800:]
    return json.loads(p.stdout)


def test_the_pages_own_parsers_answer_identically_on_the_raw_and_the_closed_output():
    names = sorted(CASES)
    raw = [json.dumps(CASES[n]) for n in names]
    closed = [_out(CASES[n]) for n in names]
    a, b = _page(raw), _page(closed)
    for n, x, y in zip(names, a, b):
        assert x == y, f"{n}: the page reads something the closed shape dropped\nraw={x}\nclosed={y}"
    # the control: the cases really exercise the parsers (a slate for every ceremony kind, an outcome line, a pending kind, a chyron, a crowned winner)
    by = dict(zip(names, a))
    assert by["eviction"]["slate"] and by["eviction"]["outcome"].endswith("(2-1)") and by["eviction"]["pendingKind"] == "ceremony-step" and by["eviction"]["announcements"] == [["a1", "eviction-result", "Role One is evicted."]]
    assert by["hoh"]["slate"]["kind"] == "hoh" and by["nominations"]["slate"]["kind"] == "nominations" and by["veto-ceremony"]["slate"]["kind"] == "veto-ceremony" and by["veto-comp"]["slate"]["kind"] == "veto-win"
    assert by["comp-round"]["outcome"].endswith("5 remain") and by["crowned"]["winner"] == "Role One" and by["corrected"]["correction"] and by["eviction"]["beatSeq"] == 41


def test_the_agent_loop_applies_it_to_the_emitted_and_the_stored_copy():
    import inspect
    src = inspect.getsource(agent_loop)
    i = src.index("_closed_output = _browser_tool_output(block.tool_type, result)")
    assert "output_text = _closed_output" in src[i:i + 200]
    # the emitted `tool_output` and the stored `_persisted_output` both read `output_text`, set AFTER the closed copy
    assert src.index('tool_output_data = {"type": "tool_output"', i) > i
    assert src.index("_persisted_output = ", i) > i


def test_negative_control_a_shape_missing_a_key_the_page_reads_is_caught_by_the_parity_check():
    names = ["eviction", "hoh"]
    raw = [json.dumps(CASES[n]) for n in names]
    cut = {k: v for k, v in SHAPE.items() if k != "event"}
    closed = [json.dumps(orwell_routes._project_for_browser(CASES[n], cut)) for n in names]
    assert _page(raw) != _page(closed), "the parity check must notice a dropped key the page reads"

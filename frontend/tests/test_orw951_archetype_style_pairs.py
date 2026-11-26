"""ORW-951: casting must tell the narrator which two strategy styles each archetype allows."""
import re
from pathlib import Path

import src.agent_tools  # noqa: F401  prime the agent_tools <-> tool_schemas import cycle
from src.tool_schemas import ARCHETYPE_STYLE_PAIRS, FUNCTION_TOOL_SCHEMAS

_TS = Path(__file__).resolve().parents[2] / "src" / "engine" / "characterFactory.ts"
_ROW = re.compile(r'\{\s*archetype:\s*"([^"]+)",\s*styles:\s*\["([^"]+)",\s*"([^"]+)"\]')


def _casting_sites():
    sites = []
    for t in FUNCTION_TOOL_SCHEMAS:
        props = t.get("function", t).get("parameters", {}).get("properties", {})
        if "strategyStyle" in props and "archetype" in props:
            sites.append((t.get("function", t)["name"], props))
    return sites


def test_pairs_match_engine_table():
    engine = {m[0]: (m[1], m[2]) for m in _ROW.findall(_TS.read_text())}
    assert engine, "no archetype rows parsed from characterFactory.ts"
    assert ARCHETYPE_STYLE_PAIRS == engine


def test_both_schema_sites_state_every_pair():
    sites = _casting_sites()
    assert len(sites) == 2, [n for n, _ in sites]
    for name, props in sites:
        d = props["strategyStyle"]["description"]
        for a, (x, y) in ARCHETYPE_STYLE_PAIRS.items():
            assert f"{a}: {x}/{y}" in d, (name, a)
        assert "MUST be one of the chosen archetype's two styles" in d
        assert "Pairs:" not in props["archetype"]["description"], "the pairs ride once per schema (prefix size)"

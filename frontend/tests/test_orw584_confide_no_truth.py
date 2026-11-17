"""ORW-584 (Vault Wall): the confide tool dump the narrator reads never carries whether the confidence was true. Roles only. SYNC."""
import asyncio
import importlib
import json

import pytest

importlib.import_module("src.agent_tools")  # import order: tool_schemas <-> agent_tools is circular when tool_schemas loads first
ti = importlib.import_module("src.tool_implementations")
orwell_engine = importlib.import_module("src.orwell_engine")


@pytest.mark.parametrize("truth", [True, False])
def test_the_confide_dump_never_contains_the_truth_key(monkeypatch, truth):
    async def fake(*a, **k):
        return {"disclosed": True, "tier": "full", "truthful": truth, "content": "a said thing", "beatSeq": 5}
    monkeypatch.setattr(orwell_engine, "confide", fake)
    out = asyncio.run(ti.do_confide('{"npcId":"npc:1"}', owner="o1"))
    assert "truthful" not in out["output"].lower()
    body = json.loads(out["output"])
    assert body["content"] == "a said thing" and body["disclosed"] is True and body["tier"] == "full"

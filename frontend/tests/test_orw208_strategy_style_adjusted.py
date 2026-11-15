"""ORW-208 FE half: a strategy-style substitution reported by the engine (`strategyStyleAdjusted`) is made visible: a health note + a plain line in the createCharacter tool result. Roles only. SYNC."""
import asyncio
import importlib
import json

ti = importlib.import_module("src.tool_implementations")
orwell_engine = importlib.import_module("src.orwell_engine")
ep = importlib.import_module("src.enrichment_policy")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _create(monkeypatch, res, calls):
    async def fake(args, user=None, **kw):
        return res

    for name in ("create_character",):
        monkeypatch.setattr(orwell_engine, name, fake)
    monkeypatch.setattr(ep, "record_runtime_failure", lambda *a, **k: calls.append((a, k)))
    return _run(ti.do_create_character('{"name":"The Player","archetype":"wildcard","strategyStyle":"strategic"}', owner="o1"))


def test_a_reported_substitution_records_a_health_note_and_tells_the_narrator(monkeypatch):
    calls = []
    res = {"started": True, "house": [], "strategyStyleAdjusted": {"requested": "strategic", "applied": "emotional", "archetype": "wildcard"}}
    out = _create(monkeypatch, res, calls)
    assert any(a[1] == "casting-strategy-style" for a, _ in calls)
    assert 'stored strategy style is "emotional"' in out["output"] and 'does not offer "strategic"' in out["output"]
    assert json.loads(out["output"].split("\n\nNOTE")[0])["strategyStyleAdjusted"]["applied"] == "emotional"


def test_no_substitution_adds_nothing(monkeypatch):
    calls = []
    out = _create(monkeypatch, {"started": True, "house": []}, calls)
    assert not [c for c in calls if c[0][1] == "casting-strategy-style"]
    assert "NOTE (engine truth)" not in out["output"]

"""0121 R2 — flag-gated deal kinds. The two active-obligation kinds (comp-throw / veto-save) are extractable
ONLY when the engine's deal-depth layer is on (read off the cached /health flag). With the flag OFF the
makeDeal schema — and every request — is byte-identical to before, so the 0108 golden-path fixture is safe.
"""
import asyncio
import copy
import importlib

import pytest


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)

# Prime the agent_tools <-> tool_schemas import cycle via the top-level module first (mirrors the working
# suite's `import src.agent_loop`), so a direct `from src.tool_schemas import ...` can't hit a partial init.
importlib.import_module("src.agent_tools")
import src.orwell_engine as oe  # noqa: E402
from src.tool_schemas import (  # noqa: E402
    FUNCTION_TOOL_SCHEMAS,
    BASE_DEAL_KINDS,
    ACTIVE_DEAL_KINDS,
    current_deal_kinds,
    with_deal_depth_kinds,
)


@pytest.fixture(autouse=True)
def _reset_flags():
    saved = dict(oe._ENGINE_FLAGS)
    oe._ENGINE_FLAGS.clear()
    yield
    oe._ENGINE_FLAGS.clear()
    oe._ENGINE_FLAGS.update(saved)


def _make_deal_schema(schemas):
    for s in schemas:
        if isinstance(s, dict) and s.get("function", {}).get("name") == "makeDeal":
            return s
    return None


def test_engine_flag_defaults_false_when_unprobed():
    assert oe.engine_flag("dealDepth") is False
    assert oe.engine_flag("dealDepth", default=True) is True  # explicit default honored


def test_current_deal_kinds_gate():
    assert current_deal_kinds() == BASE_DEAL_KINDS  # flag off (default)
    oe._ENGINE_FLAGS["dealDepth"] = True
    assert current_deal_kinds() == BASE_DEAL_KINDS + ACTIVE_DEAL_KINDS


def test_base_schema_has_only_the_defensive_four():
    # The IMPORT-frozen manifest (what the golden fixture records) must be the four defensive kinds only.
    schema = _make_deal_schema(FUNCTION_TOOL_SCHEMAS)
    assert schema is not None, "makeDeal is in the manifest"
    assert schema["function"]["parameters"]["properties"]["kind"]["enum"] == BASE_DEAL_KINDS


def test_flag_off_is_identity_and_golden_safe():
    # OFF ⇒ the SAME list object back (no copy, no change) ⇒ byte-identical request ⇒ golden fixture safe.
    schemas = list(FUNCTION_TOOL_SCHEMAS)
    out = with_deal_depth_kinds(schemas)
    assert out is schemas
    assert _make_deal_schema(out)["function"]["parameters"]["properties"]["kind"]["enum"] == BASE_DEAL_KINDS


def test_flag_on_extends_the_enum_without_mutating_the_base():
    oe._ENGINE_FLAGS["dealDepth"] = True
    base_before = copy.deepcopy(_make_deal_schema(FUNCTION_TOOL_SCHEMAS))
    out = with_deal_depth_kinds(list(FUNCTION_TOOL_SCHEMAS))
    kinds = _make_deal_schema(out)["function"]["parameters"]["properties"]["kind"]["enum"]
    assert kinds == BASE_DEAL_KINDS + ACTIVE_DEAL_KINDS
    assert "comp-throw" in kinds and "veto-save" in kinds
    # The shared import-frozen base schema is untouched (deep copy, never mutated in place).
    assert _make_deal_schema(FUNCTION_TOOL_SCHEMAS) == base_before


def test_flag_on_leaves_other_tools_untouched():
    oe._ENGINE_FLAGS["dealDepth"] = True
    out = with_deal_depth_kinds(list(FUNCTION_TOOL_SCHEMAS))
    names_in = [s.get("function", {}).get("name") for s in FUNCTION_TOOL_SCHEMAS]
    names_out = [s.get("function", {}).get("name") for s in out]
    assert names_in == names_out  # same tools, same order — only makeDeal's enum differs


def test_do_make_deal_rejects_active_kind_when_flag_off():
    from src import tool_implementations as ti
    import json
    res = _run(ti.do_make_deal(json.dumps({"with": "npc:1", "kind": "comp-throw", "terms": "throw HOH"}), owner="u"))
    assert res.get("exit_code") == 1 and "kind must be one of" in res.get("error", "")


def test_do_make_deal_accepts_active_kind_when_flag_on(monkeypatch):
    from src import tool_implementations as ti
    import json
    oe._ENGINE_FLAGS["dealDepth"] = True

    async def _fake_make_deal(with_id, kind, terms, leverage=None, traded_secret=None, user=None):
        return {"id": "deal:1", "kind": kind}

    monkeypatch.setattr(oe, "make_deal", _fake_make_deal)  # do_make_deal lazy-imports this module
    res = _run(ti.do_make_deal(json.dumps({"with": "npc:1", "kind": "veto-save", "terms": "save me"}), owner="u"))
    assert res.get("exit_code") == 0
    assert "veto-save" in res.get("output", "")


# ── B55: the proposer's DIRECTION (offer / ask) for the active kinds ──────────────────────────────────────────────
def test_direction_property_exists_only_when_deal_depth_is_on():
    """Off => the same list (byte-identical, no `direction`); on => makeDeal carries an offer/ask `direction`, and the shared base schema is never mutated."""
    base = copy.deepcopy(FUNCTION_TOOL_SCHEMAS)
    assert with_deal_depth_kinds(FUNCTION_TOOL_SCHEMAS) is FUNCTION_TOOL_SCHEMAS
    assert "direction" not in _make_deal_schema(FUNCTION_TOOL_SCHEMAS)["function"]["parameters"]["properties"]
    oe._ENGINE_FLAGS["dealDepth"] = True
    on = _make_deal_schema(with_deal_depth_kinds(FUNCTION_TOOL_SCHEMAS))["function"]["parameters"]["properties"]
    assert on["direction"]["enum"] == ["offer", "ask"]
    assert FUNCTION_TOOL_SCHEMAS == base


def test_do_make_deal_forwards_a_valid_direction_for_active_kinds_only(monkeypatch):
    import json
    from src import tool_implementations as ti
    seen = {}

    async def fake_make_deal(with_id, kind, terms, **kw):
        seen.update(kw)
        return {"id": "d1", "kind": kind}

    async def no_guard(*a, **k):
        return None, None

    monkeypatch.setattr(oe, "make_deal", fake_make_deal)
    monkeypatch.setattr(ti, "guard_make_deal", no_guard, raising=False)
    oe._ENGINE_FLAGS["dealDepth"] = True
    _run(ti.do_make_deal(json.dumps({"with": "npc:1", "kind": "comp-throw", "terms": "t", "direction": "ask"}), owner="u"))
    assert seen.get("direction") == "ask"
    seen.clear()
    _run(ti.do_make_deal(json.dumps({"with": "npc:1", "kind": "comp-throw", "terms": "t", "direction": "sideways"}), owner="u"))
    assert "direction" not in seen
    seen.clear()
    _run(ti.do_make_deal(json.dumps({"with": "npc:1", "kind": "safety", "terms": "t", "direction": "ask"}), owner="u"))
    assert "direction" not in seen

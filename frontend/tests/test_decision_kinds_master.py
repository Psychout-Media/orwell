"""Master decision-kind check (2026-11 audit, PR C).

Every pending-decision kind the ENGINE can raise must be accepted by EVERY front-end seam that relays a
decision — or the game freezes on a decision nobody can submit. That happened twice: `deal-offer` (0123,
on in deploy) and `secret-veto` (0025) were missing from three hand-copied allowlists and the model's
tool enum. Now there is ONE FE source (`orwell_engine.DECISION_KINDS`); this test pins it to the engine's
`PendingDecisionView["kind"]` union and checks every relay reads it, and that every kind that raises a
decision CARD has a card renderer (deal-offer is exempt: per the PO ruling it is never a card).
"""
import re
from pathlib import Path

FE = Path(__file__).resolve().parents[1]
REPO = FE.parent


def _engine_kinds() -> set:
    src = (REPO / "src" / "ports" / "GameSession.ts").read_text(encoding="utf-8")
    start = src.index("export interface PendingDecisionView {")
    block = re.sub(r"//[^\n]*", "", src[start:])  # drop the per-kind doc comments FIRST (they hold ';')
    m = re.search(r"kind:(.*?);", block, re.S)
    assert m, "could not find PendingDecisionView.kind in GameSession.ts"
    return set(re.findall(r'"([a-z-]+)"', m.group(1)))


def test_fe_decision_kinds_equal_the_engine_union():
    import src.agent_tools  # noqa: F401 — load order
    from src.orwell_engine import DECISION_KINDS
    engine = _engine_kinds()
    assert engine, "parsed no engine kinds"
    assert set(DECISION_KINDS) == engine, (
        f"FE DECISION_KINDS drifted from the engine union. missing={sorted(engine - set(DECISION_KINDS))} "
        f"extra={sorted(set(DECISION_KINDS) - engine)}")


def test_every_relay_reads_the_single_source():
    rest = (FE / "routes" / "orwell_routes.py").read_text(encoding="utf-8")
    ws = (FE / "routes" / "ws_routes.py").read_text(encoding="utf-8")
    impl = (FE / "src" / "tool_implementations.py").read_text(encoding="utf-8")
    schema = (FE / "src" / "tool_schemas.py").read_text(encoding="utf-8")
    assert "_DECISION_KINDS = orwell_engine.DECISION_KINDS" in rest
    assert "from src.orwell_engine import DECISION_KINDS as _DECISION_KINDS" in ws
    assert "_DECISION_KINDS = orwell_engine.DECISION_KINDS" in impl
    assert '"enum": sorted(_DECISION_KINDS)' in schema
    # No hand-copied kind set may creep back in alongside the shared one.
    for name, src in (("orwell_routes", rest), ("ws_routes", ws), ("tool_implementations", impl)):
        assert not re.search(r"_DECISION_KINDS = \{", src), f"{name} re-grew a hand-copied kind set"


def test_the_model_tool_enum_offers_every_engine_kind():
    import src.agent_tools  # noqa: F401
    from src.tool_schemas import ORWELL_GAME_TOOLS  # noqa: F401
    from src import tool_schemas
    schema = next(t for t in tool_schemas.TOOL_SCHEMAS if t["function"]["name"] == "submitDecision") \
        if hasattr(tool_schemas, "TOOL_SCHEMAS") else None
    if schema is None:
        src = (FE / "src" / "tool_schemas.py").read_text(encoding="utf-8")
        assert '"enum": sorted(_DECISION_KINDS)' in src
        return
    assert set(schema["function"]["parameters"]["properties"]["kind"]["enum"]) == _engine_kinds()


def test_every_card_kind_has_a_card_renderer():
    js = (FE / "static" / "js" / "orwellDecision.js").read_text(encoding="utf-8")
    titles = js[js.index("function titleFor("):js.index("function confirmLabelFor(")]
    card_kinds = _engine_kinds() - {"deal-offer"}  # PO ruling 2026-11-01: a deal offer is never a card
    missing = sorted(k for k in card_kinds if f'"{k}"' not in titles)
    assert not missing, f"decision kinds with no card title/renderer (would show a blank card): {missing}"

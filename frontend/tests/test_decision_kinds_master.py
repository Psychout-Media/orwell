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
    """The LIVE schema the model receives (not a source-text match) offers every engine kind."""
    import src.agent_tools  # noqa: F401
    from src.tool_schemas import FUNCTION_TOOL_SCHEMAS
    schema = next(t for t in FUNCTION_TOOL_SCHEMAS if t["function"]["name"] == "submitDecision")
    assert set(schema["function"]["parameters"]["properties"]["kind"]["enum"]) == _engine_kinds()


def test_a_deal_offer_is_never_a_pending_card():
    """PO ruling 2026-11-01: a deal offer is open state the narrator voices, never a pop-up. The engine's
    pendingView must not emit a `deal-offer` card (the FE card branch for it is dormant legacy)."""
    adapter = (REPO / "src" / "adapters" / "engine" / "GameSessionAdapter.ts").read_bytes().decode("utf-8", "replace")
    start = adapter.index("private pendingView(")
    body = adapter[start:adapter.index("\n  private ", start + 10)]
    assert 'kind: "deal-offer"' not in body, "pendingView must never raise a deal-offer card"


def test_every_card_kind_has_a_card_renderer():
    js = (FE / "static" / "js" / "orwellDecision.js").read_text(encoding="utf-8")
    titles = js[js.index("function titleFor("):js.index("function confirmLabelFor(")]
    card_kinds = _engine_kinds() - {"deal-offer", "ceremony-step"}  # PO ruling 2026-11-01: a deal offer is never a card; ORW-281 4a: a ceremony-step is a non-binding WATCH step (colour + Continue, rendered by the ceremony card, not a decision card)
    missing = sorted(k for k in card_kinds if f'"{k}"' not in titles)
    assert not missing, f"decision kinds with no card title/renderer (would show a blank card): {missing}"


def test_an_open_deal_offer_is_briefed_to_the_narrator():
    """The narrator only voices what it is told: an openDealOffer on the game state becomes a per-turn
    brief (who / kind / terms + the engine's voicing instruction); no offer ⇒ no brief."""
    import routes.chat_helpers as ch
    note = ch._deal_offer_directive({"from": {"id": "npc:3", "name": "Houseguest"}, "kind": "safety",
                                     "terms": "you keep me safe, I keep you safe", "howToVoice": "VOICE-IT"})
    assert note and "Houseguest" in note and "safety" in note and "VOICE-IT" in note
    assert "you keep me safe, I keep you safe" in note
    assert ch._deal_offer_directive(None) is None
    src = (FE / "routes" / "chat_helpers.py").read_text(encoding="utf-8")
    framing = src[src.index("async def apply_game_framing("):]
    assert '_deal_offer_directive(game_state.get("openDealOffer"))' in framing, \
        "apply_game_framing must brief the narrator on a standing deal offer"

"""ORW-86 (0123) - the in-chat deal-offer ANSWER belt, driven through the REAL `stream_agent_loop`.

A standing NPC offer is open state voiced in chat; the narrator must call submitDecision({kind:"deal-offer", vote}).
When it narrates the answer but skips the call, the belt records it. Contract (docs/design/undercall-seam-structural.md
section 5): success-gated telemetry (`auto-answer-deal-offer` counts only an APPLIED submit), model-driven answers
always win, an ambiguous answer records nothing. No model: the extraction call is a stub. Roles only.
Also pins `_reconcile_deal_term` (0109) - the spoken duration beats the submitted one.
"""
import asyncio
import json

import pytest

ROSTER = [{"id": "npc:1", "name": "Contestant Alpha", "status": "active"},
          {"id": "npc:2", "name": "Contestant Beta", "status": "active"}]
SCENE = "Contestant Alpha lets out a breath and smiles at you across the kitchen island."
OFFER = {"from": {"id": "npc:1", "name": "Contestant Alpha"}, "kind": "safety", "terms": "we protect each other this week",
         "madeWeek": 1, "howToVoice": "voice it"}


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    from src import agent_loop as al
    from routes import chat_helpers as ch
    for name in ("_SILENT_FORCE_ADVANCE_STREAK", "_ADVANCE_STALL_LEVEL", "_ADVANCE_STALL_FLAGS",
                 "_TURNS_SINCE_PROGRESS", "_ANTI_STALE_CAP_HOLDS", "_LOOP_STREAK"):
        d = getattr(al, name, None)
        if isinstance(d, dict):
            d.clear()
    al._forget_season_pacing("u")
    ch._forget_season_pacing("u")
    yield


def _drive(monkeypatch, *, user_msg, offer=OFFER, extraction='{"answer":"accept"}', submit_result=None,
           model_submits=False):
    from src import agent_loop as al
    import src.orwell_engine as oe
    import src.tool_index as ti
    import src.llm_core as lc

    monkeypatch.setenv("ORWELL_GAME_BUILD", "1")
    monkeypatch.setattr(al, "get_setting", lambda key, default=None: default)
    monkeypatch.setattr(ti, "get_tool_index", lambda: None)
    monkeypatch.setattr(al, "_loop_break_streak_update", lambda *a, **k: False)

    state = {"phase": "hoh-competition", "moment": "social", "week": 1, "beatSeq": 1, "pending": None,
             "house": ROSTER, "started": True}
    if offer:
        state["openDealOffer"] = offer

    async def fake_state(*a, **k):
        return dict(state)

    submitted = []

    async def fake_submit(decision, **k):
        submitted.append(decision)
        return submit_result if submit_result is not None else {"event": None, "pending": None, "beatSeq": 2}

    async def fake_advance(*a, **k):
        return {"beatSeq": 2, "pending": None, "event": None}

    monkeypatch.setattr(oe, "get_game_state", fake_state)
    monkeypatch.setattr(oe, "submit_decision", fake_submit)
    monkeypatch.setattr(oe, "advance_game", fake_advance)

    extractions = []

    async def fake_llm(*a, **k):
        sysmsg = " ".join(str(m.get("content")) for m in (k.get("messages") or []))
        if "put a deal offer to the player" not in sysmsg:
            return ""
        extractions.append(k.get("call_class"))
        return extraction

    monkeypatch.setattr(lc, "llm_call_async", fake_llm)

    async def _no(*a, **k):
        return False

    for n in ("_auto_record_scene", "_auto_record_deal", "_auto_confide", "_auto_expose_secret", "_auto_trade_secret",
              "_auto_move_player", "_auto_move_npc"):
        monkeypatch.setattr(al, n, _no)
    belts = []
    monkeypatch.setattr(al, "_note_belt", lambda owner, name, *a, **k: belts.append(name))

    async def fake_stream(candidates, messages, **kwargs):
        yield 'data: ' + json.dumps({"delta": SCENE}) + '\n\n'
        yield 'data: ' + json.dumps({"type": "finish", "reason": "stop"}) + '\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(al, "stream_llm_with_fallback", fake_stream)

    async def drive():
        gen = al.stream_agent_loop(
            "https://api.deepseek.com/chat/completions", "deepseek-flash",
            [{"role": "system", "content": "You are the narrator."}, {"role": "user", "content": user_msg}],
            max_rounds=3, game_mode="game", owner="u")
        async for _ in gen:
            pass

    asyncio.get_event_loop().run_until_complete(drive())
    return submitted, belts, extractions


def test_unrecorded_acceptance_is_recorded_and_counted(monkeypatch):
    submitted, belts, _ = _drive(monkeypatch, user_msg="Yes, I'm in. Let's protect each other this week.")
    assert submitted == [{"kind": "deal-offer", "vote": "accept"}]
    assert belts.count("auto-answer-deal-offer") == 1


def test_unrecorded_decline_is_recorded_too(monkeypatch):
    submitted, belts, _ = _drive(monkeypatch, user_msg="No thanks, I'll pass on that.", extraction='{"answer":"decline"}')
    assert submitted == [{"kind": "deal-offer", "vote": "decline"}]
    assert "auto-answer-deal-offer" in belts


def test_ambiguous_answer_records_nothing_and_is_not_counted(monkeypatch):
    submitted, belts, extractions = _drive(monkeypatch, user_msg="Sure, but what would you want from me first?",
                                           extraction='{"answer":"none"}')
    assert extractions, "precondition: the extraction ran"
    assert submitted == [] and "auto-answer-deal-offer" not in belts


def test_no_standing_offer_means_no_submit_and_no_count(monkeypatch):
    """The model-already-answered case looks identical from the engine: the offer is consumed, so the belt is a no-op."""
    submitted, belts, extractions = _drive(monkeypatch, user_msg="Yes, deal.", offer=None)
    assert submitted == [] and extractions == [] and "auto-answer-deal-offer" not in belts


def test_a_failed_submit_is_not_counted(monkeypatch):
    submitted, belts, _ = _drive(monkeypatch, user_msg="Yes, deal.", submit_result={"error": "refused"})
    assert len(submitted) == 1 and "auto-answer-deal-offer" not in belts


def test_a_line_that_is_not_an_answer_never_calls_the_extraction(monkeypatch):
    submitted, belts, extractions = _drive(monkeypatch, user_msg="What is for dinner tonight, anyone cooking")
    assert extractions == [] and submitted == [] and "auto-answer-deal-offer" not in belts


# ── 0109: _reconcile_deal_term ────────────────────────────────────────────────────────────────────────────────

def test_reconcile_deal_term_follows_the_spoken_duration():
    from src.tool_implementations import _reconcile_deal_term as rec
    assert rec(None, "for 3 weeks") is None
    assert rec({"weeks": 3}, "let's keep it for 3 weeks") == {"weeks": 3}
    assert rec({"weeks": 5}, "let's keep it for 3 weeks") is None          # contradicts what was spoken
    assert rec({"weeks": 3}, "we have a deal") is None                       # nothing spoken -> engine default

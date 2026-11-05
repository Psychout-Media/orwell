"""0039 deal back-fill: a struck deal the model narrates but never makeDeal's is recorded by the FE.

Found in live play (continuation of the C-02/C-03 tool-under-calling class): the GM narrated a sealed
mutual deal ("you have my word", a no-nominate pact) and skipped makeDeal — so the deal bound no one,
never reconciled against later play, and the deals surface stayed empty. The FE now back-fills makeDeal
via a HIGH-bar constrained extraction: only a clear, explicit, MUTUAL agreement is recorded, so loose
"let's work together" chatter never becomes a phantom commitment.
"""

import asyncio
import importlib

al = importlib.import_module("src.agent_loop")
orwell_engine = importlib.import_module("src.orwell_engine")
llm_core = importlib.import_module("src.llm_core")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


HOUSE = [{"id": "npc:3", "name": "Cynthia Hawkins"}, {"id": "npc:7", "name": "Tobias Drake"}]


def _wire(monkeypatch, extraction_json, deals_made):
    async def fake_llm(*a, **k):
        return extraction_json

    async def fake_make_deal(with_id, kind, terms, expected_beat_seq=None, idempotency_key=None, user=None):
        deals_made.append({"with": with_id, "kind": kind, "terms": terms, "user": user})
        return {"ok": True}

    monkeypatch.setattr(llm_core, "llm_call_async", fake_llm)
    monkeypatch.setattr(orwell_engine, "make_deal", fake_make_deal)


def test_struck_deal_is_backfilled(monkeypatch):
    deals = []
    _wire(monkeypatch, '{"struck":true,"withId":"npc:3","kind":"safety","terms":"neither nominates the other for 3 weeks"}', deals)
    out = _run(al._auto_record_deal("I shake Cynthia's hand on a no-nominate pact.", "deal with Cynthia", HOUSE, "url", "m", {}, "owner"))
    assert out is True
    assert len(deals) == 1
    assert deals[0]["with"] == "npc:3" and deals[0]["kind"] == "safety" and deals[0]["user"] == "owner"


def test_loose_talk_creates_no_phantom_deal(monkeypatch):
    deals = []
    _wire(monkeypatch, '{"struck":false}', deals)
    out = _run(al._auto_record_deal("We vaguely mused we should work together sometime.", "talk to Cynthia", HOUSE, "url", "m", {}, "owner"))
    assert out is False
    assert deals == [], "a non-mutual / loose scene must never bind the player to a deal"


def test_invalid_partner_id_is_rejected(monkeypatch):
    deals = []
    _wire(monkeypatch, '{"struck":true,"withId":"npc:99","kind":"final-two","terms":"f2"}', deals)
    out = _run(al._auto_record_deal("A final two with someone off-roster.", "x", HOUSE, "url", "m", {}, "owner"))
    assert out is False
    assert deals == []


def test_unknown_kind_defaults_to_a_safe_kind(monkeypatch):
    deals = []
    _wire(monkeypatch, '{"struck":true,"withId":"npc:7","kind":"weird","terms":"protect each other"}', deals)
    out = _run(al._auto_record_deal("Tobias and I agree to protect each other.", "x", HOUSE, "url", "m", {}, "owner"))
    assert out is True
    assert deals[0]["kind"] in al._DEAL_KINDS


def test_extraction_hiccup_is_fail_closed(monkeypatch):
    deals = []

    async def boom(*a, **k):
        raise RuntimeError("llm down")

    async def fake_make_deal(*a, **k):
        deals.append(a)
        return {}

    monkeypatch.setattr(llm_core, "llm_call_async", boom)
    monkeypatch.setattr(orwell_engine, "make_deal", fake_make_deal)
    out = _run(al._auto_record_deal("deal", "x", HOUSE, "url", "m", {}, "owner"))
    assert out is False and deals == []


def test_no_roster_is_a_noop(monkeypatch):
    deals = []
    _wire(monkeypatch, '{"struck":true,"withId":"npc:3","kind":"safety","terms":"x"}', deals)
    out = _run(al._auto_record_deal("deal", "x", [], "url", "m", {}, "owner"))
    assert out is False and deals == []


def test_deal_signal_regex_targets_commitment_language():
    rx = al._DEAL_SIGNAL_RE
    for hit in ["you have my word", "let's make a deal", "final two", "I won't put you up",
                "we shake on it", "I swear to protect you", "a no-nominate pact", "let's stick together",
                # the varied real-narration sealers that the first cut missed in live play:
                "She sticks out her hand", "He extends his hand", "You shake. Her grip is iron",
                "no nominations between us", "we vote as a bloc", "an official alliance",
                "ride or die to the end", "we lock it in"]:
        assert rx.search(hit), hit
    for miss in ["the weather is nice today", "I walked into the kitchen quietly", "she looked tired",
                 # 'block' must not trip 'bloc'; a head-shake is not a handshake:
                 "they put me on the block", "I shake my head in disbelief", "she shook her head sadly"]:
        assert not rx.search(miss), miss


def test_backfill_is_wired_into_the_finishing_block():
    import os
    js = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                           "src", "agent_loop.py"), encoding="utf-8").read()
    assert "async def _auto_record_deal" in js
    # 0065: routed through the CAS helper so the back-fill carries the compare-and-swap beatSeq token.
    assert "_backfill_with_cas(owner, _oe.make_deal, with_id, kind, terms,\n                                             user=owner, defer_fold=True,\n                                             idempotency_key=_ch_idem._mint_idempotency_key(), **_term_kw)" in js
    # 0109 — the back-fill forwards a duration the scene named (shape-filtered; the engine bounds it).
    assert '"termWeeks"' in js and '_term_kw = {"term": {"weeks": _tw}}' in js
    # gated on the per-turn cap + the cheap deal-language pre-filter over the WHOLE turn's narration
    # (a deal struck on a turn that also advanced a beat still counts — NOT gated on _progressed)
    assert "_want_deal = (_turn_deal_nudges < 1" in js
    assert "_DEAL_SIGNAL_RE.search(_turn_narration)" in js
    assert "_turn_narration = " in js and "for t in round_texts if t" in js
    assert "_want_advance or _want_record or _want_deal or" in js and "_want_reapproach:" in js
    assert "await _auto_record_deal(_turn_narration" in js
    # model-driven makeDeal always wins — it suppresses the back-fill for the turn
    assert 'block.tool_type == "makeDeal"' in js
    assert "_turn_deal_nudges = 1" in js

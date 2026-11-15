"""ORW-219: maybe_compact CAN trigger relative to the input budget (opt-in via input_budget_fn), but build_chat_context
does NOT opt in: compaction deletes stored rows (mandate #4), so it stays dormant on 1M models until the showrunner
checkpoint summaries (K6) replace it. The tests below pin the capability, the safe alignment, and that dormancy.
Original motivation: the summarizer must run BEFORE the trimmer drops anything. maybe_compact used to wait for 85% of the
RAW window (850K of a 1M model) while the trimmer enforced the much lower input budget, so a long game was trimmed
and never summarized. Now compaction triggers at 75% of the effective input budget. Roles only; no names."""
import asyncio
import uuid

import pytest

import src.context_compactor as cc
from core.models import ChatMessage, set_session_manager
import core.models as core_models
from src.model_context import estimate_tokens

WINDOW = 1_000_000
BUDGET = 600_000
GM = "GM RULES. " * 300
HARD = "HARD CONSTRAINTS: only these people are with the player."


@pytest.fixture
def mgr():
    from core.session_manager import SessionManager
    manager = SessionManager()
    prior = getattr(core_models, "_session_manager", None)
    set_session_manager(manager)
    yield manager
    set_session_manager(prior)


def _patch(monkeypatch, calls):
    async def fake_ctx(url, model):
        return WINDOW

    async def fake_llm(*a, **k):
        calls["n"] += 1
        return "SUMMARY of the older turns"

    monkeypatch.setattr(cc, "get_context_length_async", fake_ctx)
    monkeypatch.setattr(cc, "llm_call_async", fake_llm)
    monkeypatch.setattr(cc, "resolve_endpoint", lambda *a, **k: (None, None, None))
    cc._compaction_in_flight.clear()
    cc._background_tasks.clear()
    # These tests exercise the compaction mechanics on a game-shaped history. ORW-224 (separate PR) refuses
    # compaction for game sessions altogether, so neutralise that guard here when it exists.
    monkeypatch.setattr(cc, "is_game_or_casting_session", lambda s: False, raising=False)


def _long_game(mgr, sid, turns=40, chars=14_000):
    """~0.3 tokens/char: 40 turn pairs x 2 x 14K chars = ~336K... scaled below to land between 450K and 600K."""
    mgr.create_session(sid, "n", "http://x", "m", owner="u")
    sess = mgr.get_session(sid)
    sess.add_message(ChatMessage(role="user", content="casting user", metadata={"phase": "casting"}, client_msg_id=str(uuid.uuid4())))
    sess.add_message(ChatMessage(role="assistant", content="casting reply", metadata={"phase": "casting"}))
    for i in range(turns):
        sess.add_message(ChatMessage(role="user", content=f"game user {i} " + "u" * chars, metadata={"phase": "game"},
                                     client_msg_id=str(uuid.uuid4())))
        sess.add_message(ChatMessage(role="assistant", content=f"game reply {i} " + "a" * chars, metadata={"model": "m"}))
    return sess


def _ctx(sess):
    preface = [{"role": "system", "content": GM}]
    return preface + sess.get_context_messages(exclude_phases={"casting"}, exclude_pre_game=True)


def test_long_game_reaches_summarizer_before_trimmer_and_system_stays_intact(mgr, monkeypatch):
    calls = {"n": 0}
    _patch(monkeypatch, calls)
    sess = _long_game(mgr, "orw219-order", turns=45, chars=17_000)
    messages = _ctx(sess)
    used = estimate_tokens(messages)
    assert 0.75 * BUDGET < used < BUDGET, f"fixture must sit between the compaction trigger and the trim budget, got {used}"
    assert used < 0.85 * WINDOW, "the OLD trigger (85% of the raw window) would NOT have fired"

    async def drive():
        out = await cc.maybe_compact(sess, "u", "m", messages, input_budget_fn=lambda ctx: BUDGET)
        if cc._background_tasks:
            await asyncio.gather(*list(cc._background_tasks))
        return out

    asyncio.run(drive())
    assert calls["n"] == 1, "the summarizer ran while the trimmer would still have dropped nothing"
    # ... and the trimmer, at that same size, drops nothing and keeps the prompt + HARD CONSTRAINTS intact.
    with_hard = messages + [{"role": "system", "content": HARD}]
    out = cc.trim_for_context(with_hard, BUDGET, reserve_tokens=0, preserve_system=True)
    assert out == with_hard


def test_old_trigger_would_not_have_fired(mgr, monkeypatch):
    calls = {"n": 0}
    _patch(monkeypatch, calls)
    sess = _long_game(mgr, "orw219-old", turns=45, chars=17_000)
    messages = _ctx(sess)
    asyncio.run(cc.maybe_compact(sess, "u", "m", messages))  # no budget fn = legacy 85%-of-window trigger
    assert calls["n"] == 0


def test_below_budget_trigger_does_not_compact(mgr, monkeypatch):
    calls = {"n": 0}
    _patch(monkeypatch, calls)
    sess = _long_game(mgr, "orw219-small", turns=6, chars=2000)
    asyncio.run(cc.maybe_compact(sess, "u", "m", _ctx(sess), input_budget_fn=lambda ctx: BUDGET))
    assert calls["n"] == 0


def test_summary_replaces_only_the_summarized_rows_survives_restart_and_reaches_the_narrator(mgr, monkeypatch):
    calls = {"n": 0}
    _patch(monkeypatch, calls)
    sess = _long_game(mgr, "orw219-persist", turns=45, chars=17_000)
    messages = _ctx(sess)

    async def drive():
        await cc.maybe_compact(sess, "u", "m", messages, input_budget_fn=lambda ctx: BUDGET)
        await asyncio.gather(*list(cc._background_tasks))

    asyncio.run(drive())
    hist = sess.history
    assert hist[0].content == "casting user" and hist[1].content == "casting reply", "casting rows are not touched"
    summaries = [m for m in hist if (m.metadata or {}).get("compacted")]
    assert len(summaries) == 1 and summaries[0].metadata.get("phase") == "game"
    assert hist[-1].content.startswith("game reply 44"), "the recent tail is intact"
    assert len(hist) < 2 + 90

    live_ctx = sess.get_context_messages(exclude_phases={"casting"}, exclude_pre_game=True)
    assert any("[Conversation summary]" in str(m["content"]) for m in live_ctx), "the summary reaches the narrator"
    assert not any("casting" in str(m["content"]) for m in live_ctx)

    from core.session_manager import SessionManager
    fresh = SessionManager()
    set_session_manager(fresh)
    hyd = fresh.get_session("orw219-persist")
    hyd_ctx = hyd.get_context_messages(exclude_phases={"casting"}, exclude_pre_game=True)
    assert [(m["role"], m["content"]) for m in hyd_ctx] == [(m["role"], m["content"]) for m in live_ctx]


def test_trim_preserving_system_drops_summary_after_raw_turns():
    msgs = [{"role": "system", "content": "GM"},
            {"role": "system", "content": "[Conversation summary]\n" + "s" * 200},
            ] + [{"role": "user" if i % 2 == 0 else "assistant", "content": f"t{i} " + "x" * 400} for i in range(10)]
    budget = estimate_tokens(msgs) - 200
    out = cc.trim_for_context(msgs, budget, reserve_tokens=0, preserve_system=True)
    assert any(m["content"].startswith("[Conversation summary]") for m in out)
    assert out[0]["content"] == "GM"


def test_build_chat_context_does_not_activate_destructive_compaction():
    import os
    src = open(os.path.join(os.path.dirname(__file__), "..", "routes", "chat_helpers.py"), encoding="utf-8").read()
    assert "input_budget_fn" not in src.split("async def build_chat_context", 1)[1].split("return ChatContext", 1)[0].replace(
        "maybe_compact deliberately gets NO input_budget_fn", ""), "compaction must stay dormant (it deletes stored rows)"

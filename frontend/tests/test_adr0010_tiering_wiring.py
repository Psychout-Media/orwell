"""ADR 0010 / feature 0069 — Slice D wiring (the opt-in non-degradation tier IN the loop).

The pure escalate_budget is unit-tested in test_adr0010_context_tiering.py. This proves the agent loop
APPLIES it before trimming: enabled ⇒ the budget handed to trim_for_context grows toward the window;
off (default) ⇒ the lean budget is unchanged (byte-identical). Roles only.
"""
import asyncio

OR_URL = "https://openrouter.ai/api/v1/chat/completions"


def _captured_trim_budget(monkeypatch, *, tiering_enabled, context_length, msg_chars):
    from src import agent_loop as al
    from src import context_compactor as cc
    from src import settings as st

    monkeypatch.delenv("ORWELL_GAME_BUILD", raising=False)

    def fake_get_setting(key, default=None):
        if key == "context_tiering_enabled":
            return tiering_enabled
        if key == "agent_input_token_budget":
            return 6000          # default (auto-derive path)
        return default

    monkeypatch.setattr(al, "get_setting", fake_get_setting)
    monkeypatch.setattr(st, "is_setting_overridden", lambda k: False)
    import src.tool_index as ti
    monkeypatch.setattr(ti, "get_tool_index", lambda: None)

    captured: dict = {}

    def fake_trim(messages, budget, reserve_tokens=0, **kw):
        captured["budget"] = budget
        return messages

    monkeypatch.setattr(cc, "trim_for_context", fake_trim)

    async def fake_stream(candidates, messages, **kwargs):
        yield 'data: {"delta": "hi"}\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(al, "stream_llm_with_fallback", fake_stream)

    big = "word " * (msg_chars // 5)  # a long conversation that exceeds the lean 48K cap

    async def drive():
        async for _ in al.stream_agent_loop(
            OR_URL, "deepseek/deepseek-v4-pro",
            [{"role": "system", "content": "narrator"}, {"role": "user", "content": big}],
            max_rounds=1, game_mode="game", owner="tester", context_length=context_length,
        ):
            pass

    asyncio.get_event_loop().run_until_complete(drive())
    return captured.get("budget")


def test_tiering_enabled_escalates_budget_before_trim(monkeypatch):
    budget = _captured_trim_budget(monkeypatch, tiering_enabled=True,
                                   context_length=1_000_000, msg_chars=400_000)
    # Grew above the lean 48K cap toward the 1M window (never beyond ~0.85x).
    assert budget > 48_000
    assert budget <= int(1_000_000 * 0.85)


def test_tiering_off_keeps_the_lean_budget(monkeypatch):
    budget = _captured_trim_budget(monkeypatch, tiering_enabled=False,
                                   context_length=1_000_000, msg_chars=400_000)
    # Default off ⇒ the auto-derived budget, unescalated. ORW-219: model-aware, so a 1M window with
    # the default cap gets the designed 0.60 x window (was 48K).
    assert budget == 600_000

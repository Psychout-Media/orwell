"""NARR-1 (#620): the gateway narration call uses the REAL `_resolve_llm_fn` contract.

The old `gateway/handler.py` imported `_resolve_llm_fn` from `src.agent_loop` (where it does NOT
exist — it lives in `src.orwell_cast_authoring`), so the import raised every turn and the gateway
ALWAYS returned the "not configured" placeholder, never narrating. It also called the resolver as a
sync fn with `system=`/`stream=` kwargs, but the real resolver is an async `_resolve_llm_fn(owner)`
returning an `LlmFn` that takes a `messages: list[dict]` and returns a string.

These tests pin the corrected wiring: a configured model narrates; no model ⇒ the placeholder.
"""
import asyncio
import os
import sys

_FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _FRONTEND not in sys.path:
    sys.path.insert(0, _FRONTEND)

import gateway.handler as handler  # noqa: E402
import src.orwell_cast_authoring as cast_authoring  # noqa: E402


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def test_import_target_is_correct():
    """The function the handler resolves actually exists where it is now imported from."""
    assert hasattr(cast_authoring, "_resolve_llm_fn")
    src = open(os.path.join(_FRONTEND, "gateway", "handler.py"), encoding="utf-8").read()
    # must import from the module that DEFINES it, and resolve it as an async fn keyed by user
    assert "from src.orwell_cast_authoring import _resolve_llm_fn" in src
    assert "await resolve_prose_llm_fn(_resolve_llm_fn, user)" in src  # ORW-387: gateway narration is prose (no response_format)
    # and call the resolved LlmFn with the messages-list contract (no system=/stream= kwargs)
    assert "await llm_fn(messages)" in src


def test_narrates_when_a_model_resolves(monkeypatch):
    """A configured model narrates: the resolver returns an LlmFn(messages)->str and its text is
    returned (so the gateway no longer always falls back to the placeholder)."""
    captured = {}

    async def fake_llm_fn(messages):
        captured["messages"] = messages
        return "The house falls quiet as you step into the kitchen."

    async def fake_resolve(owner):
        captured["owner"] = owner
        return fake_llm_fn

    monkeypatch.setattr(cast_authoring, "_resolve_llm_fn", fake_resolve)

    out = _run(handler._narrate_gateway_turn("SYSTEM PROMPT", "I head to the kitchen", "rhino"))
    assert out == "The house falls quiet as you step into the kitchen."
    assert captured["owner"] == "rhino"
    # the system prompt + user message are both handed to the LlmFn as a messages list
    roles = [m["role"] for m in captured["messages"]]
    assert roles == ["system", "user"]
    assert captured["messages"][0]["content"] == "SYSTEM PROMPT"
    assert captured["messages"][1]["content"] == "I head to the kitchen"


def test_placeholder_when_no_model(monkeypatch):
    """No usable model ⇒ the resolver returns None ⇒ the helpful placeholder (never a crash)."""
    async def fake_resolve(owner):
        return None

    monkeypatch.setattr(cast_authoring, "_resolve_llm_fn", fake_resolve)
    out = _run(handler._narrate_gateway_turn("SYS", "hi", "rhino"))
    assert "not configured" in out.lower()

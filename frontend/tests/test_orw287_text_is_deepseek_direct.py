"""ORW-287: in the game build every text call goes to direct DeepSeek; OpenRouter is for images only.
Resolver mapping per tier, the call-time guard on all three llm_core dispatchers, the startup migration, no OpenRouter fallback
seeding, and a source guard that no text dispatcher can skip the guard. No network, no keys in any assertion."""
import asyncio
import json
import re
from pathlib import Path

import pytest

import src.text_routing as tr

SRC = Path(__file__).resolve().parents[1] / "src"
OR_URL = "https://openrouter.ai/api/v1/chat/completions"
DS_URL = "https://api.deepseek.com/chat/completions"


@pytest.fixture
def direct(monkeypatch):
    monkeypatch.setattr(tr, "active", lambda: True)
    monkeypatch.setattr(tr, "direct_deepseek_endpoint", lambda owner=None: (DS_URL, {"Authorization": "Bearer test"}, "ds1"))


def test_model_mapping():
    m = tr.map_openrouter_text_model
    assert m("deepseek/deepseek-v4.1-flash") == "deepseek-flash"
    assert m("deepseek/deepseek-v4-pro") == "deepseek-v4-pro"
    assert m("deepseek-flash") == "deepseek-flash" and m("deepseek-v4-pro") == "deepseek-v4-pro"
    assert m("qwen/qwen3.6-27b") == "deepseek-flash" and m("z-ai/glm-4.7") == "deepseek-flash" and m("") == "deepseek-flash"


@pytest.mark.parametrize("model", ["deepseek/deepseek-v4.1-flash", "qwen/qwen3.6-27b", "z-ai/glm-4.7"])
def test_openrouter_text_is_repointed_for_every_tier(direct, model):
    url, mapped, headers = tr.enforce_text_destination(OR_URL, model, {"Authorization": "Bearer or-key"})
    assert url == DS_URL and mapped.startswith("deepseek-") and headers == {"Authorization": "Bearer test"}


def test_images_and_direct_deepseek_pass_through(direct):
    assert tr.enforce_text_destination(OR_URL, "google/gemini-3.1-flash-image", {"a": "b"}) == (OR_URL, "google/gemini-3.1-flash-image", {"a": "b"})
    assert tr.enforce_text_destination(DS_URL, "deepseek-flash", {"a": "b"}) == (DS_URL, "deepseek-flash", {"a": "b"})


def test_non_game_build_is_untouched(monkeypatch):
    monkeypatch.setattr(tr, "active", lambda: False)
    assert tr.enforce_text_destination(OR_URL, "deepseek/deepseek-v4.1-flash", None) == (OR_URL, "deepseek/deepseek-v4.1-flash", None)


def test_refused_when_no_direct_endpoint(monkeypatch):
    monkeypatch.setattr(tr, "active", lambda: True)
    monkeypatch.setattr(tr, "direct_deepseek_endpoint", lambda owner=None: None)
    with pytest.raises(tr.TextRoutingRefused):
        tr.enforce_text_destination(OR_URL, "deepseek/deepseek-v4.1-flash", None)


def test_stream_surfaces_a_typed_error_not_an_openrouter_call(monkeypatch):
    import src.llm_core as llm
    monkeypatch.setattr(tr, "active", lambda: True)
    monkeypatch.setattr(tr, "direct_deepseek_endpoint", lambda owner=None: None)

    async def go():
        return [c async for c in llm.stream_llm(OR_URL, "deepseek/deepseek-v4.1-flash", [{"role": "user", "content": "hi"}])]
    chunks = asyncio.run(go())
    assert "text-provider-refused" in chunks[0] and chunks[-1].startswith("data: [DONE]")


def test_sync_and_async_calls_are_guarded(monkeypatch):
    import src.llm_core as llm
    monkeypatch.setattr(tr, "active", lambda: True)
    monkeypatch.setattr(tr, "direct_deepseek_endpoint", lambda owner=None: None)
    with pytest.raises(tr.TextRoutingRefused):
        llm.llm_call(OR_URL, "deepseek/deepseek-v4.1-flash", [{"role": "user", "content": "hi"}])
    with pytest.raises(tr.TextRoutingRefused):
        asyncio.run(llm._llm_call_async_impl(OR_URL, "deepseek/deepseek-v4.1-flash", [{"role": "user", "content": "hi"}]))


def test_guard_source_pin_every_text_dispatcher_runs_the_guard():
    src = (SRC / "llm_core.py").read_text(encoding="utf-8")
    for head in ("def llm_call(url", "async def _llm_call_async_impl(", "async def stream_llm(url"):
        body = src[src.index(head):]
        body = body[:body.index("\n\n\n")] if False else body[:9000]
        assert "_enforce_text_route(url, model, headers)" in body, f"{head} must run the ORW-287 text-route guard"


def test_no_openrouter_fallback_seed():
    import src.deepseek_seed as seed
    assert not hasattr(seed, "seed_default_model_fallbacks") and not hasattr(seed, "DEFAULT_FALLBACK_MODEL")
    assert "seed_default_model_fallbacks" not in (Path(__file__).resolve().parents[1] / "app.py").read_text(encoding="utf-8")


def test_openrouter_fallback_entries_are_skipped_for_text(monkeypatch):
    import src.endpoint_resolver as er
    monkeypatch.setattr(tr, "active", lambda: True)
    import src.settings as st
    monkeypatch.setattr(st, "load_settings", lambda: {"default_model_fallbacks": [{"endpoint_id": "or", "model": "deepseek/deepseek-v4.1-flash"}, {"endpoint_id": "ds", "model": "deepseek-flash"}]})
    monkeypatch.setattr(er, "resolve_endpoint_by_id", lambda i, m, owner=None: (OR_URL, m, {}) if i == "or" else (DS_URL, m, {}))
    assert er.resolve_chat_fallback_candidates() == [(DS_URL, "deepseek-flash", {})]

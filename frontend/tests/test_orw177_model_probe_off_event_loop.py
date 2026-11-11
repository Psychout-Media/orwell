"""ORW-177: the per-turn live `/models` probe (normalize_model_id, a blocking httpx.get) runs OFF the event loop.
A stub probe blocks 0.5 s; a ticker on the SAME loop must keep ticking. No model."""
import asyncio
import time
from pathlib import Path
from types import SimpleNamespace

import routes.chat_helpers as ch


def test_the_model_probe_does_not_block_the_event_loop(monkeypatch):
    monkeypatch.setattr(ch, "_normalize_model_id_from_cache", lambda sess: None)  # a cache miss: force the live probe

    def slow_probe(endpoint_url, model, *a, **k):
        time.sleep(0.5)  # the blocking network work
        return "resolved-model"

    monkeypatch.setattr(ch, "normalize_model_id", slow_probe)
    sess = SimpleNamespace(endpoint_url="http://endpoint/v1/chat/completions", model="requested")

    async def go():
        gaps, stop = [], asyncio.Event()

        async def ticker():
            last = time.monotonic()
            while not stop.is_set():
                await asyncio.sleep(0.02)
                now = time.monotonic()
                gaps.append(now - last)
                last = now

        t = asyncio.create_task(ticker())
        out = await ch._resolve_model_id(sess)
        stop.set()
        await t
        return out, max(gaps)

    out, worst = asyncio.run(go())
    assert out == "resolved-model"
    assert worst < 0.2, f"the event loop stalled {worst:.2f}s while the /models probe ran"


def test_a_cache_hit_skips_the_probe(monkeypatch):
    monkeypatch.setattr(ch, "_normalize_model_id_from_cache", lambda sess: "cached")
    monkeypatch.setattr(ch, "normalize_model_id", lambda *a, **k: (_ for _ in ()).throw(AssertionError("probed")))
    assert asyncio.run(ch._resolve_model_id(SimpleNamespace(endpoint_url="u", model="m"))) == "cached"


def test_source_pin_build_chat_context_uses_the_threaded_resolver():
    src = (Path(__file__).resolve().parents[1] / "routes" / "chat_helpers.py").read_text(encoding="utf-8")
    assert "norm = await _resolve_model_id(sess)" in src
    assert "or normalize_model_id(sess.endpoint_url, sess.model)\n" not in src

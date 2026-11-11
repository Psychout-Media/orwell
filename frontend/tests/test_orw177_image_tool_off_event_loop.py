"""ORW-177 slice 3: the generate_image tool (a game keep-set tool) resolves its model off the event loop. The sync
`_resolve_model` does a blocking `/models` probe (up to 5 s per endpoint); a stub blocks 0.5 s while a ticker on the
SAME loop must keep ticking. No model."""
import asyncio
import time
from pathlib import Path

import src.ai_interaction as ai


def test_generate_image_model_resolution_does_not_block_the_event_loop(monkeypatch):
    def slow_resolve(spec, owner=None):
        time.sleep(0.5)  # the blocking network probe
        raise ValueError("no endpoint")  # end the tool right after the resolution

    monkeypatch.setattr(ai, "_resolve_model", slow_resolve)

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
        out = await ai.do_generate_image("a headshot\nsome-image-model", owner=None)
        stop.set()
        await t
        return out, gaps

    out, gaps = asyncio.run(go())
    assert "No endpoint found" in out.get("error", ""), out
    assert len(gaps) >= 10, "the blocking resolution never ran, so the test proves nothing"
    assert max(gaps) < 0.2, f"the event loop stalled {max(gaps):.2f}s in do_generate_image"


def test_source_pin_blocking_calls_in_the_image_tool_are_threaded():
    src = (Path(__file__).resolve().parents[1] / "src" / "ai_interaction.py").read_text(encoding="utf-8")
    body = src.split("async def do_generate_image(", 1)[1].split("\nasync def ", 1)[0]
    assert "await asyncio.to_thread(_resolve_model, model_spec, owner=owner)" in body
    assert "await asyncio.to_thread(_resolve_model, candidate, owner=owner)" in body
    assert 'await asyncio.to_thread(httpx.get, img["url"], timeout=60)' in body
    assert "\n        url, model_id, headers = _resolve_model(" not in body

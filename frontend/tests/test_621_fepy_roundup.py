"""#621 — FE-Python roundup (FEPY-1 / FEPY-2 / FEPY-5) + #611 search-provider fallback.

FEPY-1: a mid-stream upstream error must surface as a typed `error` SSE (a styled FE notice), never
        a reply-channel body delta that reads as in-fiction producer narration.
FEPY-2: an answer routed entirely into the reasoning channel (empty body) must be RE-EMITTED as a
        non-thinking body delta, not left as a blank GM bubble.
FEPY-5: a rejected/odd recordCastProfile write-back must LOG (not silently no-op).
#611:   the search DDG provider prefers the maintained `ddgs` import, falls back to the legacy name.
"""
import asyncio
import importlib
import json

agent_loop = importlib.import_module("src.agent_loop")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# ── FEPY-1: mid-stream error → typed error SSE, not a GM body delta ──────────── #

def test_midstream_error_emits_typed_error_sse_not_body_delta():
    src_path = importlib.util.find_spec("src.agent_loop").origin
    with open(src_path, encoding="utf-8") as fh:
        src = fh.read()
    # The mid-stream error branch emits a typed `error` SSE, never a `*[Stream error` body delta.
    assert '"error": str(err_msg)' in src
    assert "*[Stream error:" not in src


# ── FEPY-2: empty body + reasoning → re-emit reasoning as a body delta ───────── #

def test_empty_body_with_reasoning_reemits_body_delta():
    # A DeepSeek-family model (the historical FEPY-2 shape: reasoning carries the answer) ⇒ re-emit.
    # P2-16 (prompt audit): an ABSENT/unknown model no longer re-emits (the safe-False default —
    # re-emitting an unknown reasoning channel risks a raw-CoT leak), so the known family is named.
    final, chunk, retry, from_reasoning = agent_loop._empty_response_fallback(
        "", "Here is the actual answer.", [], model="deepseek-chat")
    assert final == "Here is the actual answer."
    assert chunk is not None and retry is False and from_reasoning is True
    payload = json.loads(chunk[len("data: "):].strip())
    assert payload.get("delta") == "Here is the actual answer."
    assert not payload.get("thinking")  # body channel, not the accordion


def test_nonempty_body_unchanged():
    final, chunk, retry, from_reasoning = agent_loop._empty_response_fallback(
        "real body", "some reasoning", [])
    assert final == "real body" and chunk is None and retry is False and from_reasoning is False


def test_fully_empty_round_yields_error_message():
    final, chunk, retry, from_reasoning = agent_loop._empty_response_fallback("", "", [])
    assert "empty response" in final and chunk is not None
    assert retry is False  # the non-game workspace path keeps the operator string, no retry chip
    assert from_reasoning is False


# ── FEPY-5: a rejected cast-authoring write-back is LOGGED, not silent ───────── #

def test_rejected_cast_write_back_is_logged():
    from src import orwell_cast_authoring as A

    async def llm_fn(_messages):
        return json.dumps({"secrets": ["a fully fleshed-out hidden secret about this houseguest"]})

    async def write_fn(_profile):
        return {"accepted": False, "reason": "casting-incomplete"}

    # The rejected write-back must NOT silently no-op — it logs (loguru) so it's diagnosable. Capture
    # deterministically with a temporary loguru sink (the full-suite stderr capture is unreliable).
    captured = []
    handler_id = None
    try:
        handler_id = A.logger.add(lambda m: captured.append(str(m)), level="WARNING")
    except Exception:
        handler_id = None  # the no-op stand-in (importable-in-isolation path) has no .add
    try:
        written = _run(A.author_cast([{"id": "npc:7", "biography": "A seeded floor biography that the engine keeps when the writer omits its own."}], llm_fn, write_fn))
    finally:
        if handler_id is not None:
            try:
                A.logger.remove(handler_id)
            except Exception:
                pass
    assert written == 0
    if handler_id is not None:  # only assert the log text when a real loguru sink was installed
        blob = "".join(captured)
        assert "not accepted" in blob and "casting-incomplete" in blob


def test_rejected_cast_write_back_log_line_is_present_in_source():
    src_path = importlib.util.find_spec("src.orwell_cast_authoring").origin
    with open(src_path, encoding="utf-8") as fh:
        src = fh.read()
    assert "write-back not accepted for" in src


# ── #611: the DDG provider prefers `ddgs`, falls back to the legacy name ─────── #

def test_search_provider_prefers_maintained_ddgs_import():
    providers_path = importlib.util.find_spec("services.search.providers").origin
    with open(providers_path, encoding="utf-8") as fh:
        src = fh.read()
    assert "from ddgs import DDGS" in src               # maintained package first
    assert "from duckduckgo_search import DDGS" in src  # legacy fallback retained

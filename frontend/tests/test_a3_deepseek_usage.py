"""A-3 — DeepSeek's streaming usage reaches the token meter.

Live finding (A-7): the meter saw 0 tokens for every DeepSeek call. DeepSeek sends `"usage": null` on every
chunk but the last, and puts the real usage on the FINAL chunk — which ALSO carries the last delta text and
`finish_reason` (shape captured from the real API, 2026-11-03). The parser only read usage from a chunk with no
delta output, so it emitted 0/0 for the early (empty-delta) chunks and dropped the real counts. Roles only.
"""
import asyncio
import datetime as dt
import importlib
import json

import pytest

llm_core = importlib.import_module("src.llm_core")

URL = "https://api.deepseek.com/chat/completions"
USAGE = {"prompt_tokens": 10, "completion_tokens": 3, "total_tokens": 13,
         "prompt_tokens_details": {"cached_tokens": 4}, "prompt_cache_hit_tokens": 4, "prompt_cache_miss_tokens": 6}


def _chunk(content=None, role=None, finish=None, usage=None, choices=True):
    delta = {}
    if role:
        delta["role"] = role
    if content is not None:
        delta["content"] = content
    j = {"id": "x", "object": "chat.completion.chunk", "model": "deepseek-flash", "usage": usage}
    j["choices"] = [{"index": 0, "delta": delta, "finish_reason": finish}] if choices else []
    return "data: " + json.dumps(j)


class _FakeResp:
    status_code = 200

    def __init__(self, lines):
        self._lines = lines

    async def aiter_lines(self):
        for l in self._lines:
            yield l

    async def aread(self):
        return b""

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


class _FakeClient:
    def __init__(self, lines):
        self._lines = lines

    def stream(self, *a, **k):
        return _FakeResp(self._lines)


def _run_stream(monkeypatch, lines, url=URL, model="deepseek-flash"):
    monkeypatch.setattr(llm_core, "_get_http_client", lambda: _FakeClient(lines))

    async def go():
        out = []
        async for ev in llm_core.stream_llm(url, model, [{"role": "user", "content": "hi"}], max_tokens=30):
            out.append(ev)
        return out

    events = asyncio.get_event_loop().run_until_complete(go())
    usage, text = [], ""
    for e in events:
        if not e.startswith("data: ") or "[DONE]" in e:
            continue
        try:
            j = json.loads(e[6:])
        except Exception:
            continue
        if j.get("type") == "usage":
            usage.append(j["data"])
        elif "delta" in j and not j.get("thinking"):
            text += j["delta"]
    return usage, text


DEEPSEEK_STREAM = [
    _chunk(content="", role="assistant"), _chunk(content="Hel"), _chunk(content="lo "),
    _chunk(content="there", finish="stop", usage=USAGE),   # the real shape: text + finish + usage together
    "data: [DONE]",
]


def test_deepseek_final_chunk_usage_is_captured_and_the_text_is_not_lost(monkeypatch):
    usage, text = _run_stream(monkeypatch, DEEPSEEK_STREAM)
    assert text == "Hello there", "the final chunk's delta text must still stream"
    real = [u for u in usage if u.get("input_tokens")]
    assert len(real) == 1, usage
    assert real[0]["input_tokens"] == 10 and real[0]["output_tokens"] == 3
    assert real[0]["cached_tokens"] == 4


def test_null_usage_on_early_chunks_emits_no_zero_events(monkeypatch):
    usage, _ = _run_stream(monkeypatch, DEEPSEEK_STREAM)
    assert all(u.get("input_tokens") or u.get("output_tokens") for u in usage), \
        f"a 0/0 usage event would overwrite the meter: {usage}"


def test_deepseek_usage_carries_an_estimated_cost_labelled_as_such(monkeypatch):
    usage, _ = _run_stream(monkeypatch, DEEPSEEK_STREAM)
    real = [u for u in usage if u.get("input_tokens")][0]
    assert real["cost_estimated"] is True and real["cost"] > 0


def test_usage_only_final_chunk_still_works_openrouter_style(monkeypatch):
    lines = [_chunk(content="Hi", role="assistant"), _chunk(content=" there", finish="stop"),
             "data: " + json.dumps({"choices": [], "usage": {"prompt_tokens": 7, "completion_tokens": 2, "cost": 0.0012}}),
             "data: [DONE]"]
    usage, text = _run_stream(monkeypatch, lines, url="https://openrouter.ai/api/v1/chat/completions",
                              model="z-ai/glm-4.7")
    assert text == "Hi there"
    assert [u for u in usage if u.get("input_tokens")] and usage[-1]["cost"] == 0.0012
    assert "cost_estimated" not in usage[-1]  # a provider-reported cost is never relabelled


def test_a_non_deepseek_provider_gets_no_estimated_cost(monkeypatch):
    usage, _ = _run_stream(monkeypatch, DEEPSEEK_STREAM, url="https://api.example.com/v1/chat/completions",
                           model="some-other-model")
    assert usage and all("cost_estimated" not in u for u in usage)


# ── the estimate itself ──────────────────────────────────────────────────────────────────────────

OFFPEAK = dt.datetime(2026, 11, 3, 12, 0, tzinfo=dt.timezone.utc)   # Tuesday 12:00 UTC — off-peak
PEAK = dt.datetime(2026, 11, 3, 2, 0, tzinfo=dt.timezone.utc)       # Tuesday 02:00 UTC — peak
WEEKEND = dt.datetime(2026, 11, 7, 2, 0, tzinfo=dt.timezone.utc)    # Saturday — always off-peak


def test_cost_estimate_uses_published_prices_with_cache_split():
    c = llm_core._deepseek_cost_estimate("deepseek-flash", 1_000_000, 400_000, 500_000, now=OFFPEAK)
    # 0.4M hit * .003 + 0.6M miss * .15 + 0.5M out * .6 = 0.0012 + 0.09 + 0.3
    assert c == pytest.approx(0.3912, rel=1e-6)
    pro = llm_core._deepseek_cost_estimate("deepseek-v4-pro", 1_000_000, 0, 1_000_000, now=OFFPEAK)
    assert pro == pytest.approx(0.66 + 1.98, rel=1e-6)


def test_peak_hours_double_the_estimate_and_weekends_do_not():
    base = llm_core._deepseek_cost_estimate("deepseek-flash", 1000, 0, 1000, now=OFFPEAK)
    assert llm_core._deepseek_cost_estimate("deepseek-flash", 1000, 0, 1000, now=PEAK) == pytest.approx(2 * base)
    assert llm_core._deepseek_cost_estimate("deepseek-flash", 1000, 0, 1000, now=WEEKEND) == pytest.approx(base)


def test_unpriced_models_have_no_estimate_and_cached_never_exceeds_prompt():
    assert llm_core._deepseek_cost_estimate("mystery-model", 10, 0, 10) is None
    c = llm_core._deepseek_cost_estimate("deepseek-flash", 100, 999, 0, now=OFFPEAK)  # clamps hit to prompt
    assert c == pytest.approx(100 * 0.003 / 1_000_000)


# ── the estimate flag survives to the ledger and the admin totals (#1973 review) ─────────────────────

def test_ledger_persists_the_estimated_flag_and_admin_totals_surface_it(monkeypatch, tmp_path):
    tl = importlib.import_module("src.orwell_token_ledger")
    # An ISOLATED ledger file: never touch (or race on) the shared application store.
    monkeypatch.setattr(tl, "LEDGER_PATH", tmp_path / "ledger.json")
    tl.record_turn("est-user", session="s1", turn_id="t1", call_class="narration", input_tokens=10,
                   output_tokens=3, cost=0.001, cost_estimated=True, provider="openai")
    tl.record_turn("est-user", session="s1", turn_id="t2", call_class="narration", input_tokens=10,
                   output_tokens=3, cost=0.002, cost_estimated=False, provider="openrouter")
    rows = tl.get_recent("est-user", 10)
    assert [r["costEstimated"] for r in rows] == [True, False]
    ah = importlib.import_module("routes.admin_health_routes")
    summary = ah._token_economy("est-user")["summary"]
    assert summary["totalCost"] == pytest.approx(0.003)
    assert summary["estimatedCost"] == pytest.approx(0.001) and summary["costIsEstimated"] is True


def test_agent_loop_carries_the_estimated_flag_from_usage_to_the_ledger():
    src = open(importlib.import_module("src.agent_loop").__file__, encoding="utf-8").read()
    assert 'if u.get("cost_estimated"):' in src and "real_cost_estimated = True" in src
    assert "cost_estimated=real_cost_estimated," in src

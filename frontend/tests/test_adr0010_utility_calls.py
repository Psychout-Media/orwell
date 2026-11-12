"""ADR 0010 / feature 0069 — the gap closure: the non-streaming utility/background path is now
budgeted AND metered, so all four call classes are real (not just narration + casting).

`llm_call_async(call_class=..., user=...)` resolves the per-class reasoning budget and records one
Vault-free token/cost entry per call. No call_class ⇒ byte-identical (no reasoning, no usage-accounting
request, no ledger entry). Roles only.
"""
import pytest
import asyncio

pytestmark = pytest.mark.usefixtures("non_game_text_routing")  # ORW-287: pins the OpenRouter payload shape (non-game build)

OR_URL = "https://openrouter.ai/api/v1/chat/completions"

_DATA = {
    "choices": [{"message": {"content": "ok"}}],
    "usage": {
        "prompt_tokens": 100, "completion_tokens": 50,
        "prompt_tokens_details": {"cached_tokens": 20},
        "completion_tokens_details": {"reasoning_tokens": 30},
        "cost": 0.001,
    },
}


class _FakeResp:
    def __init__(self, data):
        self._data = data
        self.is_success = True
        self.status_code = 200
        self.text = ""

    def json(self):
        return self._data


class _FakeClient:
    def __init__(self, sink, data):
        self._sink = sink
        self._data = data

    async def post(self, url, headers=None, json=None, timeout=None):
        self._sink["payload"] = json
        return _FakeResp(self._data)


def _run(monkeypatch, *, call_class, user, data=_DATA):
    from src import llm_core as lc
    from src import llm_trace
    from src import orwell_token_ledger as tl

    sink = {}
    monkeypatch.setattr(lc, "_get_http_client", lambda: _FakeClient(sink, data))
    monkeypatch.setattr(lc, "_is_host_dead", lambda u: False)
    monkeypatch.setattr(lc, "note_model_activity", lambda *a, **k: None)
    monkeypatch.setattr(lc, "_clear_host_dead", lambda *a, **k: None)
    monkeypatch.setattr(lc, "_get_cached_response", lambda k: None)
    monkeypatch.setattr(lc, "_set_cached_response", lambda *a, **k: None)
    monkeypatch.setattr(llm_trace, "enabled", lambda: False)
    recorded = []
    monkeypatch.setattr(tl, "record_turn", lambda u, **kw: recorded.append((u, kw)))

    async def drive():
        return await lc.llm_call_async(
            OR_URL, "deepseek/deepseek-v4-pro",
            [{"role": "user", "content": "x"}], call_class=call_class, user=user)

    text = asyncio.get_event_loop().run_until_complete(drive())
    return sink.get("payload") or {}, recorded, text


def test_utility_call_gets_its_reasoning_budget(monkeypatch):
    payload, _recorded, _text = _run(monkeypatch, call_class="utility-extraction", user="tester")
    # utility-extraction default = "off" → a GENUINE disable on a reasoning model (not an omission,
    # which would leave the provider default ON). OpenRouter unified form: {"enabled": False}.
    assert payload.get("reasoning") == {"enabled": False}
    assert payload.get("usage") == {"include": True}          # OpenRouter cost accounting, for the meter


def test_utility_call_is_metered_to_the_ledger(monkeypatch):
    _payload, recorded, _text = _run(monkeypatch, call_class="utility-extraction", user="tester")
    assert len(recorded) == 1, "a metered utility call must record exactly one ledger entry"
    u, kw = recorded[0]
    assert u == "tester"
    assert kw["call_class"] == "utility-extraction"
    assert kw["input_tokens"] == 100 and kw["output_tokens"] == 50
    assert kw["cached_tokens"] == 20 and kw["reasoning_tokens"] == 30
    assert abs(float(kw["cost"]) - 0.001) < 1e-9


def test_background_authoring_class_resolves_reasoning_off(monkeypatch):
    # #1007: background-authoring is "off" (settings default) — structured JSON extraction, not a
    # reasoning task. On a reasoning model that resolves to a GENUINE disable on the wire
    # (reasoning:{"enabled": False}), not an omission (which would leave the provider default ON and
    # burn the output cap before any visible JSON — the live 0/15 floor-fallback this fixes).
    payload, recorded, _text = _run(monkeypatch, call_class="background-authoring", user="tester")
    assert payload.get("reasoning") == {"enabled": False}
    assert len(recorded) == 1 and recorded[0][1]["call_class"] == "background-authoring"


def test_no_call_class_is_byte_identical(monkeypatch):
    payload, recorded, _text = _run(monkeypatch, call_class=None, user=None)
    assert "reasoning" not in payload and "reasoning_effort" not in payload
    assert "usage" not in payload, "no usage-accounting request when not metering"
    assert recorded == [], "a non-classed call is never metered"


def test_call_class_without_user_budgets_but_does_not_meter(monkeypatch):
    # The verifier path: gets the reasoning budget, but with no user it is not recorded.
    payload, recorded, _text = _run(monkeypatch, call_class="utility-extraction", user=None)
    assert payload.get("reasoning") == {"enabled": False}   # off ⇒ genuine disable, still applied
    assert "usage" not in payload          # no metering ⇒ no usage-accounting request
    assert recorded == []                  # no user ⇒ not metered


def test_orw292_traced_call_without_user_records_usage_but_is_not_metered(monkeypatch):
    # ORW-292: the llm-io record of a non-stream call carries the provider's usage even with no user.
    from src import llm_trace
    seen = []
    monkeypatch.setattr(llm_trace, "record_llm_call", lambda **kw: seen.append(kw))
    from src import llm_core as lc
    import asyncio as _a
    sink = {}
    monkeypatch.setattr(lc, "_get_http_client", lambda: _FakeClient(sink, _DATA))
    monkeypatch.setattr(lc, "_is_host_dead", lambda u: False)
    monkeypatch.setattr(lc, "note_model_activity", lambda *a, **k: None)
    monkeypatch.setattr(lc, "_clear_host_dead", lambda *a, **k: None)
    monkeypatch.setattr(lc, "_get_cached_response", lambda k: None)
    monkeypatch.setattr(lc, "_set_cached_response", lambda *a, **k: None)
    monkeypatch.setattr(llm_trace, "enabled", lambda: True)
    from src import orwell_token_ledger as tl
    recorded = []
    monkeypatch.setattr(tl, "record_turn", lambda u, **kw: recorded.append((u, kw)))
    _a.get_event_loop().run_until_complete(lc.llm_call_async(
        OR_URL, "m", [{"role": "user", "content": "x"}], call_class="utility-extraction", user=None))
    u = seen[-1]["response"]["usage"]
    assert u["input_tokens"] == 100 and u["output_tokens"] == 50 and u["cached_tokens"] == 20
    assert recorded == []


def test_orw292_meter_user_buckets_auth_off_as_default():
    from src.agent_loop import _meter_user
    assert _meter_user(None) == "default" and _meter_user("role-user") == "role-user"

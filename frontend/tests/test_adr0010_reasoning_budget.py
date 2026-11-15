"""ADR 0010 / feature 0069 — Slice B (the reasoning budget, the dominant cost lever).

Two legs, both driven for real:
  • the llm_core payload builder actually puts a `reasoning` budget on the wire — and crucially it
    FIRES for the live model (DeepSeek-V4 via OpenRouter), which `_supports_thinking` does NOT match;
  • the agent loop resolves the per-call-class policy and passes it down (admin-overridable; off→omit;
    non-game chat carries no policy ⇒ byte-identical).

Roles only.
"""
import pytest
import asyncio
import json

pytestmark = pytest.mark.usefixtures("non_game_text_routing")  # ORW-287: pins the OpenRouter payload shape (non-game build)

OR_URL = "https://openrouter.ai/api/v1/chat/completions"
OAI_URL = "https://api.openai.com/v1/chat/completions"


# ── llm_core builder: a `reasoning` budget reaches the payload (provider-aware) ────

class _FakeResp:
    status_code = 200

    async def aiter_lines(self):
        for ln in ['data: {"choices":[{"delta":{"content":"hi"}}]}', "data: [DONE]"]:
            yield ln

    async def aread(self):
        return b""


class _FakeStreamCM:
    def __init__(self, captured, payload):
        captured["payload"] = payload

    async def __aenter__(self):
        return _FakeResp()

    async def __aexit__(self, *a):
        return False


class _FakeClient:
    def __init__(self, captured):
        self._captured = captured

    def stream(self, method, url, json=None, headers=None, timeout=None):
        return _FakeStreamCM(self._captured, json)


def _capture_payload(monkeypatch, url, model, *, policy, max_tokens=0):
    from src import llm_core as lc
    captured: dict = {}
    monkeypatch.setattr(lc, "_get_http_client", lambda: _FakeClient(captured))
    monkeypatch.setattr(lc, "_is_host_dead", lambda u: False)
    monkeypatch.setattr(lc, "note_model_activity", lambda *a, **k: None)
    monkeypatch.setattr(lc, "_clear_host_dead", lambda *a, **k: None)

    async def drive():
        async for _ in lc.stream_llm(url, model, [{"role": "user", "content": "x"}],
                                     max_tokens=max_tokens, policy=policy):
            pass

    asyncio.get_event_loop().run_until_complete(drive())
    return captured.get("payload") or {}


def test_reasoning_fires_for_the_live_model_via_openrouter(monkeypatch):
    # The whole point: DeepSeek-V4 is a reasoning model but `_supports_thinking` doesn't match it,
    # so the budget MUST still reach the wire through the OpenRouter unified-param path.
    from src.token_policy import resolve_output_cap, resolve_reasoning_max_tokens
    p = _capture_payload(monkeypatch, OR_URL, "deepseek/deepseek-v4-pro",
                         policy={"reasoning": {"effort": "medium"}, "max_tokens": 4096})
    r = p.get("reasoning")
    # OpenRouter's unified `reasoning` takes EITHER effort OR max_tokens, NEVER BOTH (a 400 otherwise
    # — see test_openrouter_reasoning_never_sends_both_effort_and_max_tokens). We send the precise
    # `max_tokens` bound ALONE and DROP effort: the budget still reaches the wire (the DeepSeek-V4
    # point stands), sized off the model-aware output cap and reserving reply headroom by construction
    # (F-S4-D, #1420-#2).
    assert isinstance(r, dict) and "effort" not in r, r
    cap = resolve_output_cap("deepseek/deepseek-v4-pro")
    assert r.get("max_tokens") == resolve_reasoning_max_tokens(cap), r
    assert 0 < r["max_tokens"] < cap, "reasoning must leave the reply room within the output cap"


def test_reasoning_max_tokens_reserves_reply_headroom(monkeypatch):
    # The reasoning sub-budget must always leave a majority-share of the output cap for the reply —
    # bounding reasoning below the reply's reserve is the whole F-S4-D cure.
    from src.token_policy import resolve_output_cap
    p = _capture_payload(monkeypatch, OR_URL, "deepseek/deepseek-v4-pro",
                         policy={"reasoning": {"effort": "medium"}})
    cap = resolve_output_cap("deepseek/deepseek-v4-pro")
    reasoning_budget = p["reasoning"]["max_tokens"]
    assert cap - reasoning_budget >= reasoning_budget, "the reply must keep at least as much as thinking"


def test_explicit_tight_request_cap_shrinks_the_reasoning_budget(monkeypatch):
    # When the caller/admin sends a TIGHT explicit output cap, the reasoning sub-budget must shrink
    # with it (sized off the tighter of the request cap and the model default) — the reply is sacred
    # even under a small cap. A big model-aware default must never over-budget reasoning past a small
    # request cap.
    from src.token_policy import resolve_reasoning_max_tokens
    p_tight = _capture_payload(monkeypatch, OR_URL, "deepseek/deepseek-v4-pro",
                               policy={"reasoning": {"effort": "medium"}}, max_tokens=2000)
    tight = p_tight["reasoning"]["max_tokens"]
    assert tight == resolve_reasoning_max_tokens(2000), tight
    assert 2000 - tight >= int(0.4 * 2000), "even a tight cap must reserve reply headroom"


def test_openrouter_reasoning_never_sends_both_effort_and_max_tokens(monkeypatch):
    # THE regression guard for the live bug (found by the 0108 golden RECORD): OpenRouter's unified
    # `reasoning` accepts EITHER `effort` OR `max_tokens`, never both — sending both returns
    # HTTP 400 "Only one of reasoning.effort and reasoning.max_tokens can be specified" (observed on
    # z-ai/glm-5.2 via Novita), which EMPTIES the response and stalls the game. Every automated gate
    # stubs the LLM, so only a real key exercised this — this test pins the invariant at the payload
    # layer across models + caps so it can't regress silently again.
    for model in ("deepseek/deepseek-v4-pro", "z-ai/glm-5.2", "qwen/qwen3.6-flash"):
        for mt in (0, 2000, 256):
            p = _capture_payload(monkeypatch, OR_URL, model,
                                 policy={"reasoning": {"effort": "high"}}, max_tokens=mt)
            r = p.get("reasoning") or {}
            both = ("effort" in r) and ("max_tokens" in r)
            assert not both, f"{model} @max_tokens={mt}: reasoning carries BOTH effort+max_tokens ⇒ OpenRouter 400: {r}"
            # and it must carry at least ONE of them (reasoning still reaches the wire)
            assert ("effort" in r) or ("max_tokens" in r), f"{model} @max_tokens={mt}: reasoning empty {r}"


def test_openrouter_anthropic_omits_a_subfloor_reasoning_max_tokens(monkeypatch):
    # #1481 (Greptile P1, T-Rex-verified): OpenRouter documents a 1024-token MINIMUM for Anthropic
    # `reasoning.max_tokens`. A tight admin output cap drives our reply-reserving sub-budget below
    # that floor (cap 256 → 153), and Anthropic REJECTS the request instead of using it. For a Claude
    # model below the floor we must NOT send the explicit sub-budget — `effort` (plus the tight cap
    # itself) governs — so the request is accepted rather than 400ing.
    from src.token_policy import resolve_reasoning_max_tokens
    assert resolve_reasoning_max_tokens(256) < 1024  # precondition: the tight cap dips under the floor
    p = _capture_payload(monkeypatch, OR_URL, "anthropic/claude-sonnet-4",
                         policy={"reasoning": {"effort": "medium"}}, max_tokens=256)
    r = p.get("reasoning")
    assert isinstance(r, dict) and r.get("effort") == "medium", r
    assert "max_tokens" not in r, "a sub-1024 Anthropic reasoning.max_tokens must be omitted, not sent"


def test_openrouter_anthropic_keeps_a_valid_reasoning_max_tokens(monkeypatch):
    # At the usual (untightened) caps the sub-budget is far above the 1024 floor, so it rides normally
    # for a Claude model too — the guard is a no-op on the common path (never silently drops thinking).
    from src.token_policy import resolve_output_cap, resolve_reasoning_max_tokens
    p = _capture_payload(monkeypatch, OR_URL, "anthropic/claude-sonnet-4",
                         policy={"reasoning": {"effort": "medium"}})
    cap = resolve_output_cap("anthropic/claude-sonnet-4")
    r = p["reasoning"]
    assert r["max_tokens"] == resolve_reasoning_max_tokens(cap) >= 1024, r


def test_openrouter_non_anthropic_keeps_a_subfloor_reasoning_max_tokens(monkeypatch):
    # A non-Anthropic reasoner has NO documented floor, so a sub-1024 value is both valid AND is what
    # protects its reply from the reasoning chain under a tight cap (#835) — it must STILL be sent.
    # (Guards the fix against over-reaching into the DeepSeek/other-reasoner path.)
    from src.token_policy import resolve_reasoning_max_tokens
    expected = resolve_reasoning_max_tokens(256)
    assert expected < 1024
    p = _capture_payload(monkeypatch, OR_URL, "deepseek/deepseek-v4-pro",
                         policy={"reasoning": {"effort": "medium"}}, max_tokens=256)
    assert p["reasoning"]["max_tokens"] == expected, "DeepSeek keeps its sub-floor reply-protecting budget"


def test_o_series_reasoning_effort_carries_no_token_subbudget(monkeypatch):
    # OpenAI o-series reasoning is intrinsic/effort-only — it rides `reasoning_effort`, NOT a
    # `reasoning` map, so there is no token sub-budget to attach (and none must appear).
    p = _capture_payload(monkeypatch, OAI_URL, "o3-mini", policy={"reasoning": {"effort": "medium"}})
    assert p.get("reasoning_effort") == "medium"
    assert "reasoning" not in p


def test_direct_thinking_provider_stays_effort_only_no_subbudget(monkeypatch):
    # A thinking model served by a NON-OpenRouter provider keeps the effort-only `reasoning` map
    # (byte-identical to before) — the `max_tokens` sub-budget is an OpenRouter unified param, so we
    # do not send it to a direct provider that may not understand it.
    p = _capture_payload(monkeypatch, OAI_URL, "qwen3-max", policy={"reasoning": {"effort": "medium"}})
    assert p.get("reasoning") == {"effort": "medium"}


def test_reasoning_off_is_a_genuine_disable_on_openrouter(monkeypatch):
    # "off" (policy reasoning is None) must ACTIVELY disable reasoning on a reasoning model —
    # OMITTING the field would leave the provider default (often ON), so "off" would not be a
    # cost floor. OpenRouter unified form: reasoning:{"enabled": false}.
    p = _capture_payload(monkeypatch, OR_URL, "deepseek/deepseek-v4-pro", policy={"reasoning": None})
    assert p.get("reasoning") == {"enabled": False}


def test_reasoning_off_left_untouched_for_openai_o_series(monkeypatch):
    # o-series reasoning is intrinsic and cannot be disabled — we leave the default (no field).
    p = _capture_payload(monkeypatch, OAI_URL, "o3-mini", policy={"reasoning": None})
    assert "reasoning" not in p and "reasoning_effort" not in p


def test_no_policy_is_byte_identical_no_reasoning(monkeypatch):
    p = _capture_payload(monkeypatch, OR_URL, "deepseek/deepseek-v4-pro", policy=None)
    assert "reasoning" not in p and "reasoning_effort" not in p


def test_openai_o_series_uses_reasoning_effort(monkeypatch):
    p = _capture_payload(monkeypatch, OAI_URL, "o3-mini", policy={"reasoning": {"effort": "low"}})
    assert p.get("reasoning_effort") == "low"
    assert "reasoning" not in p


def test_plain_openai_model_gets_no_reasoning_field(monkeypatch):
    # A non-reasoning OpenAI model must NOT receive `reasoning`/`reasoning_effort` (would 400).
    p = _capture_payload(monkeypatch, OAI_URL, "gpt-4o-mini", policy={"reasoning": {"effort": "medium"}})
    assert "reasoning" not in p and "reasoning_effort" not in p


# ── agent_loop: resolve the per-call-class policy and pass it down ────────────────

def _drive_loop_capture_policy(monkeypatch, *, game_mode, reasoning_budget=None):
    from src import agent_loop as al

    monkeypatch.delenv("ORWELL_GAME_BUILD", raising=False)

    def fake_get_setting(key, default=None):
        if key == "reasoning_budget":
            return reasoning_budget if reasoning_budget is not None else (default or {})
        return default

    monkeypatch.setattr(al, "get_setting", fake_get_setting)
    import src.tool_index as ti
    monkeypatch.setattr(ti, "get_tool_index", lambda: None)

    cap: dict = {}

    async def fake_stream(candidates, messages, **kwargs):
        cap.update(kwargs)
        yield 'data: {"delta": "hi"}\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(al, "stream_llm_with_fallback", fake_stream)

    async def drive():
        async for _ in al.stream_agent_loop(
            OR_URL, "deepseek/deepseek-v4-pro",
            [{"role": "system", "content": "narrator"}, {"role": "user", "content": "lap"}],
            max_rounds=1, game_mode=game_mode, owner="tester",
        ):
            pass

    asyncio.get_event_loop().run_until_complete(drive())
    return cap


def test_loop_resolves_and_passes_narration_policy(monkeypatch):
    cap = _drive_loop_capture_policy(monkeypatch, game_mode="game")
    assert cap.get("policy") is not None
    assert cap["policy"].get("reasoning") == {"effort": "medium"}  # ratified narration default


def test_loop_admin_override_off_omits_reasoning(monkeypatch):
    cap = _drive_loop_capture_policy(monkeypatch, game_mode="game", reasoning_budget={"narration": "off"})
    assert cap.get("policy") is not None
    assert cap["policy"].get("reasoning") is None  # admin set narration -> off


def test_loop_non_game_chat_passes_no_policy(monkeypatch):
    cap = _drive_loop_capture_policy(monkeypatch, game_mode=None)
    assert cap.get("policy") is None  # platform chat is unchanged (no reasoning override)

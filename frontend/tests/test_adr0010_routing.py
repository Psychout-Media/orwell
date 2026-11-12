"""ADR 0010 / feature 0069 — Slice C (cache-friendly routing).

Per-session stickiness keeps OpenRouter on the cache-warm provider; above the high-token threshold a
large prompt PINS (no fallback) so it never cold-cache-misses. Default threshold 0 ⇒ pin off ⇒
byte-identical routing. Roles only.
"""
import asyncio

OR_URL = "https://openrouter.ai/api/v1/chat/completions"


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


def _capture(monkeypatch, *, session_id=None, pin_provider=False, provider_opts=None):
    from src import llm_core as lc
    captured: dict = {}
    monkeypatch.setattr(lc, "_get_http_client", lambda: _FakeClient(captured))
    monkeypatch.setattr(lc, "_is_host_dead", lambda u: False)
    monkeypatch.setattr(lc, "note_model_activity", lambda *a, **k: None)
    monkeypatch.setattr(lc, "_clear_host_dead", lambda *a, **k: None)

    async def drive():
        async for _ in lc.stream_llm(OR_URL, "deepseek/deepseek-v4-pro",
                                     [{"role": "user", "content": "x"}],
                                     session_id=session_id, pin_provider=pin_provider,
                                     provider_opts=provider_opts):
            pass

    asyncio.get_event_loop().run_until_complete(drive())
    return captured.get("payload") or {}


def test_session_id_sets_stickiness_user(monkeypatch):
    p = _capture(monkeypatch, session_id="canon-123")
    assert p.get("user") == "canon-123"


def test_no_session_id_no_user_field(monkeypatch):
    p = _capture(monkeypatch, session_id=None)
    assert "user" not in p


def test_pin_provider_disables_fallbacks(monkeypatch):
    p = _capture(monkeypatch, session_id="canon-123", pin_provider=True)
    assert p.get("provider") == {"allow_fallbacks": False}


def test_no_pin_leaves_routing_default(monkeypatch):
    p = _capture(monkeypatch, session_id="canon-123", pin_provider=False)
    assert "provider" not in p


# ── the loop threads the CANONICAL session id (0064) as the stickiness key ────────

def test_loop_passes_canonical_session_id(monkeypatch):
    from src import agent_loop as al
    from src import orwell_game_session as gs

    monkeypatch.delenv("ORWELL_GAME_BUILD", raising=False)
    monkeypatch.setattr(al, "get_setting", lambda key, default=None: default)
    monkeypatch.setattr(gs, "get_game_session", lambda user: "canon-xyz")
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
            [{"role": "system", "content": "n"}, {"role": "user", "content": "u"}],
            max_rounds=1, game_mode="game", owner="tester",
        ):
            pass

    asyncio.get_event_loop().run_until_complete(drive())
    assert cap.get("session_id") == "canon-xyz"
    # pin is off by default (threshold 0) — availability preserved.
    assert cap.get("pin_provider") is False


# ── admin-supplied OpenRouter `provider` routing object (merged with the pin) ──────

def test_admin_provider_object_is_sent(monkeypatch):
    p = _capture(monkeypatch, provider_opts={"sort": "throughput"})
    assert p.get("provider") == {"sort": "throughput"}


def test_admin_provider_object_with_order_and_max_price(monkeypatch):
    opts = {"order": ["deepinfra/turbo"], "max_price": {"prompt": 1, "completion": 2}}
    p = _capture(monkeypatch, provider_opts=opts)
    assert p.get("provider") == opts


def test_pin_overlays_allow_fallbacks_on_admin_object(monkeypatch):
    p = _capture(monkeypatch, provider_opts={"order": ["deepinfra"], "allow_fallbacks": True},
                 pin_provider=True)
    assert p["provider"]["order"] == ["deepinfra"]
    assert p["provider"]["allow_fallbacks"] is False  # the high-token pin wins for big prompts


def test_non_dict_provider_opts_ignored(monkeypatch):
    p = _capture(monkeypatch, provider_opts="garbage")
    assert "provider" not in p


def test_loop_passes_admin_provider_object(monkeypatch):
    from src import agent_loop as al
    from src import orwell_game_session as gs

    monkeypatch.delenv("ORWELL_GAME_BUILD", raising=False)

    def fake_get_setting(key, default=None):
        if key == "openrouter_provider":
            return {"sort": "throughput"}
        # The provider pin is scoped to the narration model (review 2026-07-14): it attaches
        # only when the call's model == default_model, so the utility tier can never inherit a
        # narrator-only provider pin. Align default_model with this call's model so the pin applies.
        if key == "default_model":
            return "deepseek/deepseek-v4-pro"
        return default

    monkeypatch.setattr(al, "get_setting", fake_get_setting)
    monkeypatch.setattr(gs, "get_game_session", lambda user: "canon-1")
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
            [{"role": "system", "content": "n"}, {"role": "user", "content": "u"}],
            max_rounds=1, game_mode="game", owner="tester",
        ):
            pass

    asyncio.get_event_loop().run_until_complete(drive())
    assert cap.get("provider_opts") == {"sort": "throughput"}

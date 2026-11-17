"""ORW-362: GPT Image 2.6 Sunburst via OpenRouter's Image API (POST {base}/images), with a
one-shot Gemini chat-route fallback. Roles only; httpx fully faked (no network, no spend).
pytest-asyncio is AUTO mode -> SYNC tests driven through run_until_complete."""

import asyncio
import base64
import importlib

import pytest

op = importlib.import_module("src.orwell_portraits")
GPT = "openai/gpt-image-2.6-sunburst"
GEM = "google/gemini-3.1-flash-image"
BASE = "https://openrouter.ai/api/v1"


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


class _Resp:
    def __init__(self, status=200, body=None, text=""):
        self.status_code = status
        self._body = body
        self.text = text

    def json(self):
        return self._body


class _Client:
    def __init__(self, resp=None, exc=None):
        self.resp, self.exc = resp, exc
        self.posts = []

    async def post(self, url, json=None, headers=None):
        self.posts.append((url, json, headers))
        if self.exc:
            raise self.exc
        return self.resp


def _ok(png=b"PNGBYTES", usage=None):
    body = {"data": [{"b64_json": base64.b64encode(png).decode()}]}
    if usage is not None:
        body["usage"] = usage
    return _Resp(200, body)


def test_request_body_without_reference():
    c = _Client(_ok())
    out = _run(op._generate_via_openrouter_images(c, BASE + "/", GPT, "a face", {"Authorization": "Bearer k"}, None, "high"))
    assert out == b"PNGBYTES"
    url, body, headers = c.posts[0]
    assert url == BASE + "/images"
    assert body == {"model": GPT, "prompt": "a face", "n": 1, "aspect_ratio": "1:1",
                    "quality": "high", "output_format": "png"}
    assert headers == {"Authorization": "Bearer k"}


def test_request_body_with_reference():
    c = _Client(_ok())
    _run(op._generate_via_openrouter_images(c, BASE, GPT, "p", {}, b"REF", "medium"))
    body = c.posts[0][1]
    assert body["input_references"] == [
        {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(b"REF").decode()}}]


@pytest.mark.parametrize("given,sent", [("low", "low"), ("medium", "medium"), ("high", "high"),
                                        ("auto", "medium"), ("bogus", "medium"), (None, "medium")])
def test_quality_mapping(given, sent):
    c = _Client(_ok())
    _run(op._generate_via_openrouter_images(c, BASE, GPT, "p", {}, None, given))
    assert c.posts[0][1]["quality"] == sent


def test_cost_recorded_in_ledger(monkeypatch):
    from src import orwell_token_ledger as led
    calls = []
    monkeypatch.setattr(led, "record_turn", lambda user, **kw: calls.append((user, kw)))
    c = _Client(_ok(usage={"completion_tokens": 123, "cost": 0.042}))
    assert _run(op._generate_via_openrouter_images(c, BASE, GPT, "p", {}, None, "medium", user="u")) == b"PNGBYTES"
    assert calls == [("u", {"call_class": "portrait", "output_tokens": 123, "cost": 0.042, "provider": "openrouter"})]


def test_missing_usage_does_not_fail(monkeypatch):
    from src import orwell_token_ledger as led
    calls = []
    monkeypatch.setattr(led, "record_turn", lambda user, **kw: calls.append(kw))
    c = _Client(_ok())
    assert _run(op._generate_via_openrouter_images(c, BASE, GPT, "p", {}, None, "medium")) == b"PNGBYTES"
    assert calls[0]["output_tokens"] == 0 and calls[0]["cost"] == 0.0


# ── failures record the red reason and return None ───────────────────────────────────────

@pytest.mark.parametrize("client,reason", [
    (_Client(_Resp(400, {"error": {"message": "bad"}}, text="bad")), "http-400"),
    (_Client(_Resp(503, {}, text="down")), "http-503"),
    (_Client(exc=TimeoutError("t")), "TimeoutError"),
    (_Client(_Resp(200, {"data": []})), "empty-data"),
    (_Client(_Resp(200, {"data": [{}]})), "missing-b64"),
])
def test_failure_records_reason(client, reason):
    op._consume_gen_error()
    assert _run(op._generate_via_openrouter_images(client, BASE, GPT, "p", {}, None, "medium")) is None
    assert op._consume_gen_error() == "gpt-image-failed"
    assert reason in (op._consume_gen_detail() or "")


# ── routing + fallback through _generate_one ─────────────────────────────────────────────

def _setup(monkeypatch, model, client):
    import httpx
    import src.ai_interaction as ai
    monkeypatch.setattr(op, "_image_settings", lambda u: (True, model, "medium"))
    monkeypatch.setattr(op, "image_gen_disabled", lambda: False)
    # ORW-480: these tests cover the Gemini FALLBACK path itself: the setting is on and the GPT retries are off (the retry policy has its own tests)
    monkeypatch.setattr(op, "gemini_fallback_enabled", lambda u: True)
    monkeypatch.setattr(op, "GPT_RETRY_WAITS_S", ())
    monkeypatch.setattr(ai, "_resolve_model",
                        lambda spec, owner=None: (BASE + "/chat/completions", spec, {"Authorization": "Bearer k"}))
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: _AsyncCtx(client))
    chat = []

    async def fake_chat(c, url, model_id, prompt, headers, reference_png=None):
        chat.append((url, model_id, reference_png))
        return b"GEMINI"
    monkeypatch.setattr(op, "_generate_via_chat_completions", fake_chat)
    return chat


class _AsyncCtx:
    def __init__(self, c):
        self.c = c

    async def __aenter__(self):
        return self.c

    async def __aexit__(self, *a):
        return False


def test_gemini_on_openrouter_still_uses_chat_route(monkeypatch):
    c = _Client(_ok())
    chat = _setup(monkeypatch, GEM, c)
    assert _run(op._generate_one("p", "u")) == b"GEMINI"
    assert chat and chat[0][1] == GEM and c.posts == []


def test_gpt_image_uses_images_route(monkeypatch):
    c = _Client(_ok(b"GPT"))
    chat = _setup(monkeypatch, GPT, c)
    assert _run(op._generate_one("p", "u")) == b"GPT"
    assert c.posts[0][0] == BASE + "/images" and chat == []


@pytest.mark.parametrize("client", [
    _Client(_Resp(404, {}, text="x")), _Client(_Resp(502, {}, text="x")),
    _Client(exc=TimeoutError("t")), _Client(_Resp(200, {"data": []})),
])
def test_failure_falls_back_to_gemini_once(monkeypatch, client):
    chat = _setup(monkeypatch, GPT, client)
    op._consume_gen_error()
    assert _run(op._generate_one("p", "u", reference_png=b"R")) == b"GEMINI"
    assert len(client.posts) == 1 and len(chat) == 1
    assert chat[0][1] == "google/gemini-3.1-flash-image" and chat[0][2] == b"R"
    # ORW-389: the fallback made the photo, so the GPT Image reason is cleared, not left red
    assert op._consume_gen_error() is None


def _failing_fallback(monkeypatch, client, reason):
    chat = _setup(monkeypatch, GPT, client)

    async def fail_chat(c, url, model_id, prompt, headers, reference_png=None):
        chat.append(model_id)
        op._note_gen_error(reason)
        return None
    monkeypatch.setattr(op, "_generate_via_chat_completions", fail_chat)
    op._consume_gen_error()
    return chat


def test_a_transient_fallback_failure_keeps_its_reason_so_the_reconciler_sees_an_outage(monkeypatch):
    _failing_fallback(monkeypatch, _Client(_Resp(404, {}, text="x")), "http-429")
    assert _run(op._generate_one("p", "u")) is None
    assert op._consume_gen_error() == "http-429"


def test_a_permanent_fallback_failure_still_leaves_the_gpt_reason(monkeypatch):
    _failing_fallback(monkeypatch, _Client(_Resp(404, {}, text="x")), "http-400")
    assert _run(op._generate_one("p", "u")) is None
    assert op._consume_gen_error() == "gpt-image-failed"


def test_an_open_billing_breaker_on_the_fallback_host_blocks_the_fallback_call(monkeypatch):
    chat = _failing_fallback(monkeypatch, _Client(_Resp(404, {}, text="x")), "http-500")
    op.reset_billing_breaker()
    try:
        op._trip_billing_breaker(op._provider_host(BASE + "/chat/completions"))
        assert _run(op._gpt_image_fallback(None, "u", "p", None, ctx={})) is None
        assert chat == []  # no paid call went to the host whose breaker is open
    finally:
        op.reset_billing_breaker()


@pytest.mark.parametrize("bad", [2.5, "abc", True, "2.5"])
def test_a_malformed_retry_counter_is_exhausted_not_zero(bad):
    m = {"a": {"check": {"ok": False}, "source": "generated", "checkRetries": bad},
         "b": {"check": {"ok": False}, "source": "generated"},
         "c": {"check": {"ok": False}, "source": "generated", "checkRetries": 1}}
    assert op.check_retry_ids(m) == ["b", "c"]


# ── resolution without a model-list entry ───────────────────────────────────────────────

def test_resolve_model_accepts_gpt_image_without_catalog(monkeypatch):
    import types
    import src.ai_interaction as ai
    import src.database as dbm
    ep = types.SimpleNamespace(base_url="https://openrouter.ai/api/v1", api_key="k", name="OR", is_enabled=True)

    class Q:
        def filter(self, *a, **k): return self
        def all(self): return [ep]

    class S:
        def query(self, *a): return Q()
        def close(self): pass

    monkeypatch.setattr(dbm, "SessionLocal", lambda: S())
    import httpx
    monkeypatch.setattr(httpx, "get", lambda *a, **k: (_ for _ in ()).throw(AssertionError("catalog probed")))
    import src.auth_helpers as ah
    monkeypatch.setattr(ah, "is_admin_user", lambda u: True)
    url, model, headers = ai._resolve_model(GPT, owner="u")
    assert model == GPT and "openrouter.ai" in url

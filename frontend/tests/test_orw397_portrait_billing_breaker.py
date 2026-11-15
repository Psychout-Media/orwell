"""ORW-397: an image provider that refuses for billing/auth (HTTP 401/402/403) trips a per-provider
breaker: one provider call, one admin-visible credits/billing soft failure, no chat fallback, no
attempt for the next houseguest, a re-probe no sooner than an hour, and a good probe closes it."""

import asyncio
import importlib

import pytest

P = importlib.import_module("src.orwell_portraits")
U = importlib.import_module("src.orwell_portrait_upgrade")
engine = importlib.import_module("src.orwell_engine")
ai = importlib.import_module("src.ai_interaction")
log_rings = importlib.import_module("src.log_rings")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _card(i):
    return {"id": f"npc:{i}", "name": f"Guest {i}", "status": "active"}


@pytest.fixture
def world(tmp_path, monkeypatch):
    monkeypatch.setattr(P, "PORTRAITS_DIR", tmp_path / "portraits")
    monkeypatch.setattr(P, "image_generation_available", lambda user: True)
    monkeypatch.setattr(P, "image_gen_disabled", lambda: False)

    async def _host(user):  # ORW-437: the breaker is per host; pin this user's host to the fake provider's
        return "api.provider.test"

    monkeypatch.setattr(P, "image_provider_host", _host)
    P.reset_billing_breaker()
    U._STATE.clear()
    U._BUSY.clear()
    P._INFLIGHT.clear()
    P._GEN_PROGRESS.clear()

    async def _idle():
        return False

    monkeypatch.setattr(U, "game_is_live", _idle)  # idle: the parallel path (width 3) is the risky one
    state = {"started": True, "player": {"id": "player", "name": "Me"}, "house": [_card(1), _card(2), _card(3)]}

    async def get_state(user=None, timeout=None):
        return state

    async def get_pp(hid, user=None):
        return {"houseguestId": hid, "name": "Guest " + hid.split(":")[1], "prompt": f"v2 prompt {hid}"}

    monkeypatch.setattr(engine, "get_game_state", get_state)
    monkeypatch.setattr(engine, "get_portrait_prompt", get_pp)
    d = P.user_portrait_dir("u")
    d.mkdir(parents=True)
    m = {}
    for sid in ("npc_1", "npc_2", "npc_3"):
        (d / f"{sid}.png").write_bytes(b"PNG:old")
        m[sid] = {"file": f"{sid}.png", "name": "Guest " + sid.split("_")[-1], "source": "generated", "promptVersion": 1}
    P._save_manifest("u", m)
    soft = []
    monkeypatch.setattr(log_rings, "record_soft_failure", lambda cls, exc, **kw: soft.append((cls, str(exc))))
    yield soft
    P.reset_billing_breaker()


def _provider(monkeypatch, statuses):
    """Fake the provider behind `_generate_one`: returns `statuses` in order (sticking at the last)."""
    calls = []

    async def inner(prompt, user, reference_png=None, keep_identity=True, _ctx=None):
        _ctx["host"] = "api.provider.test"
        if not P._breaker_allows("api.provider.test"):
            _ctx["skipped"] = True
            P._note_gen_error(P.BILLING_BREAKER_OPEN_REASON)
            return None
        calls.append(prompt)
        st = statuses[min(len(calls) - 1, len(statuses) - 1)]
        if st == 200:
            return b"PNG:new"
        P._note_gen_error(f"http-{st}")
        return None

    monkeypatch.setattr(P, "_generate_one_inner", inner)
    return calls


@pytest.mark.parametrize("status", [401, 402, 403])
def test_billing_error_one_call_one_soft_failure_no_next_houseguest(world, monkeypatch, status):
    calls = _provider(monkeypatch, [status])
    t = 1000.0
    _run(U.upgrade_tick("u", now=t))                      # arm the quiet window
    assert _run(U.upgrade_tick("u", now=t + 46)) == "failed"
    assert len(calls) == 1                                # exactly one provider call
    for k in range(2, 8):                                 # later ticks: nobody else is tried
        assert _run(U.upgrade_tick("u", now=t + 46 + k * 20)) == "waiting"
    assert len(calls) == 1
    billing = [s for s in world if "credits" in s[1] and "billing" in s[1]]
    assert len(billing) == 1 and len(world) == 1          # ONE soft failure, and it says credits/billing


def test_breaker_blocks_direct_calls_until_the_hour_then_one_probe_closes_it(world, monkeypatch):
    calls = _provider(monkeypatch, [402, 200])
    assert _run(P._generate_one("p", "u")) is None
    assert P.billing_breaker_open()
    assert _run(P._generate_one("p", "u")) is None        # blocked, no provider call
    assert len(calls) == 1
    host = "api.provider.test"
    P._BILLING_BREAKER[host]["opened_at"] -= P.BILLING_REPROBE_S + 1   # the hour is up
    assert P.billing_breaker_probing()
    assert _run(P._generate_one("p", "u")) == b"PNG:new"  # the probe
    assert not P._BILLING_BREAKER                         # closed
    assert _run(P._generate_one("p", "u")) == b"PNG:new"


def test_failed_probe_reopens_without_a_second_soft_failure(world, monkeypatch):
    _provider(monkeypatch, [402])
    _run(P._generate_one("p", "u"))
    P._note_generation_failure("u", "npc_1", "http-402")
    P._note_generation_failure("u", "npc_2", "http-402")
    assert len(world) == 1
    P._BILLING_BREAKER["api.provider.test"]["opened_at"] -= P.BILLING_REPROBE_S + 1
    _run(P._generate_one("p", "u"))                        # probe fails again
    assert P.billing_breaker_open()
    P._note_generation_failure("u", "npc_1", "http-402")
    assert len(world) == 1


def test_upgrade_resumes_after_probe_succeeds(world, monkeypatch):
    calls = _provider(monkeypatch, [402, 200])
    t = 1000.0
    _run(U.upgrade_tick("u", now=t))
    assert _run(U.upgrade_tick("u", now=t + 46)) == "failed"
    P._BILLING_BREAKER["api.provider.test"]["opened_at"] -= P.BILLING_REPROBE_S + 1
    assert _run(U.upgrade_tick("u", now=t + 100)) == "upgraded"
    assert len(calls) == 2
    assert not P._BILLING_BREAKER


def test_images_402_makes_no_chat_fallback_call(world, monkeypatch):
    """Provider level: an OpenRouter GPT Image 402 on /images must not go on to a chat call."""
    posts = []

    class Resp:
        status_code = 402
        text = "insufficient credits"
        content = b""

        def json(self):
            return {"error": {"message": "insufficient credits"}}

    class Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json=None, headers=None):
            posts.append(url)
            return Resp()

    import httpx
    monkeypatch.setattr(httpx, "AsyncClient", Client)
    monkeypatch.setattr(P, "_image_settings", lambda user: (True, "openai/gpt-image-2", "medium"))
    monkeypatch.setattr(ai, "_resolve_model",
                        lambda spec, owner=None: ("https://openrouter.ai/api/v1/chat/completions", "openai/gpt-image-2", {}))
    assert _run(P._generate_one("a face", "u")) is None
    assert len(posts) == 1 and posts[0].endswith("/images")
    assert P.billing_breaker_open()
    assert _run(P._generate_one("a face", "u")) is None   # breaker: still no new call
    assert len(posts) == 1


def test_parallel_first_calls_are_serialised_so_a_refusal_costs_one_call(world, monkeypatch):
    calls = _provider(monkeypatch, [402])

    async def go():
        return await asyncio.gather(*[P._generate_one(f"p{i}", "u") for i in range(3)])

    assert _run(go()) == [None, None, None]
    assert len(calls) == 1

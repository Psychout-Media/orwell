"""#1936 (0070) — the off-screen texture prose is either surfaced or NOT generated.

The enrichment paid for up to MAX_SCENES_PER_TICK LLM calls per advance to voice hidden NPC-to-NPC scenes as prose
that no player-visible surface ever displays (audit 2026-10-25 Tier 1 #10). Option (b): it is OFF by default
(`offscreen_texture_enrichment`), so no paid call is made until the prose is routed into an overhear/gossip
surface. This pins (1) the default, (2) that the gate makes ZERO model resolves / engine reads / LLM calls — and
no strict-policy failure — both from `run_enrich` and from the advance-time `kickoff_enrich`, and (3) that turning
it on restores the full behavior. Roles only.
"""
import asyncio
import importlib

import pytest

T = importlib.import_module("src.orwell_offscreen_texture")
settings_mod = importlib.import_module("src.settings")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def test_the_enrichment_is_off_by_default():
    assert settings_mod.DEFAULT_SETTINGS["offscreen_texture_enrichment"] is False
    assert T.enrichment_enabled() is False


@pytest.fixture
def spies(monkeypatch):
    calls = {"resolve": 0, "skeletons": 0, "write": 0}
    cast = importlib.import_module("src.orwell_cast_authoring")
    engine = importlib.import_module("src.orwell_engine")

    async def resolver(owner):
        calls["resolve"] += 1

        async def _fn(messages):
            return "prose"
        return _fn

    async def skeletons(user=None):
        calls["skeletons"] += 1
        return [{"eventId": "e1", "nature": "gossip", "participants": ["npc:1", "npc:2"], "template": "t"}]

    async def write(event_id, content, user=None):
        calls["write"] += 1
        return {"ok": True}

    monkeypatch.setattr(cast, "_resolve_llm_fn", resolver)
    monkeypatch.setattr(engine, "get_offscreen_scene_skeletons", skeletons)
    monkeypatch.setattr(engine, "record_offscreen_scene_texture", write)
    return calls


def test_disabled_run_enrich_makes_no_model_call_engine_read_or_write(spies):
    res = _run(T.run_enrich("u"))
    assert res == {"voiced": 0, "total": 0, "reason": "disabled"}
    assert spies == {"resolve": 0, "skeletons": 0, "write": 0}


def test_disabled_run_enrich_records_no_strict_policy_failure(monkeypatch, spies):
    ep = importlib.import_module("src.enrichment_policy")
    seen = []
    monkeypatch.setattr(ep, "is_strict", lambda: True)
    monkeypatch.setattr(ep, "record_failure", lambda *a, **k: seen.append(a))
    _run(T.run_enrich("u"))
    assert seen == [], "a deliberately-off enrichment must not light the strict 'unwired class' ledger"


def test_disabled_kickoff_schedules_nothing(monkeypatch, spies):
    async def go():
        T.kickoff_enrich("u")
        await asyncio.sleep(0)  # let any (wrongly) scheduled task run
        return list(T._IN_FLIGHT)

    in_flight = _run(go())
    assert in_flight == [] and spies == {"resolve": 0, "skeletons": 0, "write": 0}


def test_enabling_it_restores_the_full_voicing_path(monkeypatch, spies):
    monkeypatch.setattr(T, "enrichment_enabled", lambda: True)
    res = _run(T.run_enrich("u"))
    assert res["voiced"] == 1 and spies["write"] == 1 and spies["resolve"] == 1


def test_the_setting_is_read_through_get_setting(monkeypatch):
    monkeypatch.setattr(settings_mod, "get_setting", lambda k, d=None: True if k == "offscreen_texture_enrichment" else d)
    assert T.enrichment_enabled() is True
    monkeypatch.setattr(settings_mod, "get_setting", lambda k, d=None: (_ for _ in ()).throw(RuntimeError("x")))
    assert T.enrichment_enabled() is False  # fail-closed


@pytest.mark.parametrize("raw", ["false", "False", "0", "no", "off", "", 0, 1, "true", "yes", None, [], {}])
def test_only_a_real_boolean_true_turns_it_on(monkeypatch, raw):
    """bool("false") is True — a serialized/malformed setting must never switch the paid calls on."""
    monkeypatch.setattr(settings_mod, "get_setting", lambda k, d=None: raw if k == "offscreen_texture_enrichment" else d)
    assert T.enrichment_enabled() is False, repr(raw)

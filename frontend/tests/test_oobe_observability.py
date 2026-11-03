"""OOBE default-endpoint brick — the OBSERVABILITY half (follow-on to
`test_oobe_default_endpoint_fix.py`, which gates the resolution fix itself).

The live failure was not just the brick — it was SILENT: the player saw only in-fiction
stalling, the operator found nothing ("castAuthoring: null" while `enrichment.failures`
carried the whole story), and a fresh session's narrator silently swapped to an arbitrary
provider-list model. Gated here:

  1. The createCharacter no-model refusal is OPERATOR-ACTIONABLE: a structured
     `refusalKind`/`unwiredClasses` marker + a message naming the one-step fix, and the
     agent loop surfaces it as a production note (the existing OOC system-note affordance),
     never the generic stall nudge.
  2. The runtime overseer (0079/0080 seams) NOTICES the model-wiring failure class off the
     enrichment failure ledger — reporting "resolvable now" (the resolver's single-endpoint
     auto-default) or ESCALATING with the one-step fix through `log_rings.record_overseer`
     (the existing "Overseer (live)" channel — no parallel monitor).
  3. /admin/status renders the cast-authoring run state + the per-class enrichment failure
     ledger as its own section (Vault-free: timestamps / call classes / reasons / ids only),
     and the payload is no longer null-blind pre-game.
  4. /api/default-chat never swaps the CONFIGURED default model for "first model in the
     provider list" on a stale cached model list (the openai/gpt-5.6-luna-pro class): the
     membership (F) re-derive fires only when the cache was refreshed in-process.

Roles only — account usernames are opaque keys, never houseguest material.
"""

import importlib
import json
import os

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

endpoint_resolver = importlib.import_module("src.endpoint_resolver")
settings_mod = importlib.import_module("src.settings")
auth_helpers = importlib.import_module("src.auth_helpers")
enrichment = importlib.import_module("src.enrichment_policy")
llm_core = importlib.import_module("src.llm_core")


def _seed_single_openrouter_endpoint(ep_id="ep-or", *, api_key="sk-live-test", owner=None,
                                     enabled=True, model_type="llm", cached=None):
    from core.database import SessionLocal, ModelEndpoint
    db = SessionLocal()
    try:
        db.query(ModelEndpoint).delete()
        db.add(ModelEndpoint(
            id=ep_id, name="OpenRouter", base_url="https://openrouter.ai/api/v1",
            api_key=api_key, is_enabled=enabled, model_type=model_type,
            cached_models=json.dumps(cached) if cached is not None else None, owner=owner,
        ))
        db.commit()
    finally:
        db.close()


def _clear_endpoints():
    from core.database import SessionLocal, ModelEndpoint
    db = SessionLocal()
    try:
        db.query(ModelEndpoint).delete()
        db.commit()
    finally:
        db.close()


@pytest.fixture(autouse=True)
def _endpoint_isolation():
    """The per-worker test DB is shared across files — never leave a keyed enabled endpoint
    behind (it would make the single-endpoint auto-default fire inside unrelated tests)."""
    _clear_endpoints()
    yield
    _clear_endpoints()


@pytest.fixture()
def post_reset_settings(monkeypatch):
    """The live post-reset settings state (settings.json ≈ {} ⇒ the DEFAULT_SETTINGS merge)."""
    merged = dict(settings_mod.DEFAULT_SETTINGS)
    # Models an install CONFIGURED for OpenRouter's pair (the OOB default is DeepSeek, PO 2026-11-02).
    merged["default_model"] = "z-ai/glm-4.7"
    merged["utility_model"] = "qwen/qwen3.6-27b"
    monkeypatch.setattr(settings_mod, "load_settings", lambda: dict(merged))
    monkeypatch.setattr(settings_mod, "get_setting",
                        lambda key, default=None: merged.get(key, default))
    import routes.prefs_routes as prefs_routes
    monkeypatch.setattr(prefs_routes, "_load_for_user", lambda user: {})
    return merged


@pytest.fixture()
def rhino_is_admin(monkeypatch):
    monkeypatch.setattr(auth_helpers, "is_admin_user", lambda user: user == "rhino")


# ═══════════════════════════════════════════════════════════════════════════════════════
# 1. Surfacing — the no-model refusal is operator-actionable, never in-fiction stalling
# ═══════════════════════════════════════════════════════════════════════════════════════

def test_no_model_refusal_carries_operator_actionable_reason(monkeypatch, run):
    """The strict refusal names the one-step fix (Settings → Models) and carries the
    structured `refusalKind` marker the agent loop keys its production-note steer on."""
    monkeypatch.setenv("ORWELL_ENRICHMENT_POLICY", "strict")

    oe = importlib.import_module("src.orwell_engine")
    ti = importlib.import_module("src.tool_implementations")
    ca = importlib.import_module("src.orwell_cast_authoring")

    async def _none(owner, **k):
        return None
    monkeypatch.setattr(ca, "resolve_authoring_llm_fn", _none)
    monkeypatch.setattr(ca, "_resolve_llm_fn", _none)

    async def fake_state(*a, **k):
        return {"started": False}
    monkeypatch.setattr(oe, "get_game_state", fake_state)

    enrichment.clear_failures("tester-refusal")
    res = run(ti.do_create_character('{"playerName":"P"}', owner="tester-refusal"))
    assert res.get("exit_code") == 1
    assert res.get("refusalKind") == "no-model-wired"
    assert isinstance(res.get("unwiredClasses"), list) and res["unwiredClasses"]
    err = res.get("error") or ""
    assert "Settings" in err and "endpoint" in err, \
        "the refusal must tell the operator the one-step fix"


def test_agent_loop_surfaces_the_no_model_refusal_as_a_production_note():
    """The forced-finalize seam keys on refusalKind and injects the OOC production note (the
    same affordance the casting-incomplete refusal uses) — never the generic stall nudge that
    reads as in-fiction stalling."""
    al = importlib.import_module("src.agent_loop")
    steer = al._creation_no_model_steer(["cast-authoring", "zeitgeist"],
                                        "Game creation refused (strict enrichment policy): …")
    assert steer.startswith("(Production note"), "must ride the existing production-note affordance"
    assert "cast-authoring" in steer
    assert "Settings" in steer, "the note must carry the operator's one-step fix"
    assert "OUT OF CHARACTER" in steer.upper()
    # Source pin: the forced-finalize branch detects the structured marker BEFORE the generic
    # "did not start" fallthrough, and does not march the stall counter on it.
    with open(os.path.join(FRONTEND, "src", "agent_loop.py"), encoding="utf-8") as f:
        src = f.read()
    assert 'refusalKind") == "no-model-wired"' in src.replace("'", '"'), \
        "the forced createCharacter seam must detect the no-model refusal kind"
    assert "_creation_no_model_steer(" in src


# ═══════════════════════════════════════════════════════════════════════════════════════
# 2. Overseer — the failure class is noticed and reported through the existing channel
# ═══════════════════════════════════════════════════════════════════════════════════════

def test_overseer_escalates_when_no_keyed_endpoint_exists(post_reset_settings, monkeypatch):
    monkeypatch.setattr(auth_helpers, "is_admin_user", lambda user: False)
    _clear_endpoints()
    ov = importlib.import_module("src.overseer")
    lr = importlib.import_module("src.log_rings")
    enrichment.clear_failures("ov-user")
    enrichment.record_failure("ov-user", "cast-genesis",
                              "no model resolved for the cast-genesis call class")
    verdict = ov.assess_enrichment_health("ov-user", force=True)
    assert verdict and verdict["detected"] is True and verdict["resolvable"] is False
    assert "Settings" in verdict["diagnosis"], "the alert must carry the one-step fix"
    _, lines = lr.OVERSEER.since(0)
    ours = [l for l in lines if l.get("kind") == "model-wiring" and l.get("user") == "ov-user"]
    assert ours and ours[-1]["overseerLevel"] == "escalation" and ours[-1]["ok"] is False


def test_overseer_reports_resolution_when_the_auto_default_can_fix_it(
        post_reset_settings, rhino_is_admin):
    _seed_single_openrouter_endpoint(owner=None)
    ov = importlib.import_module("src.overseer")
    lr = importlib.import_module("src.log_rings")
    enrichment.clear_failures("rhino")
    enrichment.record_failure(
        "rhino", "cast-authoring",
        "no model resolved for the cast-authoring call class — authoring cannot run")
    verdict = ov.assess_enrichment_health("rhino", force=True)
    assert verdict and verdict["resolvable"] is True
    # The overseer probes the utility→default chain; since 2026-07-13 the unset utility
    # ENDPOINT keeps the CONFIGURED utility MODEL (the ADR 0016 qwen tier) instead of
    # collapsing to the narrator — either way it must be a CONFIGURED identity, never an
    # arbitrary provider-list pick.
    assert verdict.get("model") == "qwen/qwen3.6-27b", \
        "the reported resolution must be the CONFIGURED utility identity"
    _, lines = lr.OVERSEER.since(0)
    ours = [l for l in lines if l.get("kind") == "model-wiring" and l.get("user") == "rhino"]
    assert ours and ours[-1]["overseerLevel"] == "action"


def test_overseer_assessment_is_quiet_without_signal():
    ov = importlib.import_module("src.overseer")
    enrichment.clear_failures("quiet-user")
    assert ov.assess_enrichment_health("quiet-user", force=True) is None


def test_overseer_assessment_is_debounced_per_user(post_reset_settings, monkeypatch):
    monkeypatch.setattr(auth_helpers, "is_admin_user", lambda user: False)
    ov = importlib.import_module("src.overseer")
    ov._last_enrich_assess.pop("debounce-user", None)
    enrichment.clear_failures("debounce-user")
    enrichment._FAILURES["debounce-user"] = [
        {"at": 1.0, "callClass": "cast-genesis", "reason": "no model resolved"}]
    first = ov.assess_enrichment_health("debounce-user")
    second = ov.assess_enrichment_health("debounce-user")
    assert first is not None
    assert second is None, "a refusal burst must assess once per debounce window"
    assert ov.assess_enrichment_health("debounce-user", force=True) is not None


def test_record_failure_hooks_the_overseer_for_no_model_failures(monkeypatch):
    """The detection rides the EXISTING ledger seam — a recorded no-model failure triggers the
    overseer assessment (debounced inside); a non-wiring failure does not."""
    ov = importlib.import_module("src.overseer")
    seen = []
    monkeypatch.setattr(ov, "assess_enrichment_health",
                        lambda user, **k: seen.append(user))
    enrichment.clear_failures("hook-user")
    enrichment.record_failure("hook-user", "cast-identity",
                              "no model resolved for the cast-identity call class")
    assert seen == ["hook-user"]
    enrichment.record_failure("hook-user", "cast-authoring", "2/15 fell back to the floor")
    assert seen == ["hook-user"], "only the no-model class triggers the wiring assessment"


# ═══════════════════════════════════════════════════════════════════════════════════════
# 3. /admin/status — enrichment failures + cast-authoring run state are rendered
# ═══════════════════════════════════════════════════════════════════════════════════════

def test_admin_health_payload_carries_enrichment_failures(monkeypatch, run):
    ahr = importlib.import_module("routes.admin_health_routes")
    enrichment.clear_failures("health-user")
    enrichment.record_failure("health-user", "cast-genesis",
                              "no model resolved for the cast-genesis call class")

    async def _detail():
        return {"ok": False, "engineUrl": "http://x", "error": "down"}

    async def _raw():
        return None, None
    monkeypatch.setattr(ahr.orwell_engine, "engine_health_detail", _detail)
    monkeypatch.setattr(ahr, "_engine_raw_health", _raw)
    snap = run(ahr._health_snapshot("health-user"))
    enr = snap.get("enrichment")
    assert enr and enr.get("policy") in ("soft", "strict")
    fails = enr.get("failures") or []
    assert any(f.get("callClass") == "cast-genesis" for f in fails)
    assert all(set(f) <= {"at", "callClass", "reason", "detail"} for f in fails), \
        "Vault-free: timestamps / class / reason only"
    assert "castAuthoring" in snap


def test_admin_status_page_renders_the_enrichment_section():
    """Source pin: the self-contained /admin/status page renders d.enrichment.failures as its
    own section (timestamp / call class / reason), so an operator SEES the refusal story."""
    with open(os.path.join(FRONTEND, "routes", "admin_health_routes.py"), encoding="utf-8") as f:
        src = f.read()
    assert 'id="enrichwrap"' in src, "the status page must carry the enrichment section"
    assert "CAST AUTHORING" in src and "ENRICHMENT" in src
    assert "d.enrichment" in src, "render() must read the enrichment payload"
    assert "f.callClass" in src, "the section must render per-class failure rows"
    # The pre-game run state renders too (never null-blind during casting).
    assert "ca.pregame" in src and "houseEntryHold" in src


# ═══════════════════════════════════════════════════════════════════════════════════════
# 4. /api/default-chat — never an arbitrary provider-list model on a stale cache
# ═══════════════════════════════════════════════════════════════════════════════════════

def _default_chat_client(monkeypatch, settings):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    model_routes = importlib.import_module("routes.model_routes")
    monkeypatch.setenv("AUTH_ENABLED", "false")  # single-user → the global-settings branch
    monkeypatch.setattr(model_routes, "_load_settings", lambda: dict(settings))
    app = FastAPI()
    app.include_router(model_routes.setup_model_routes(object()))
    return model_routes, TestClient(app, raise_server_exceptions=False)


def test_default_chat_keeps_the_stored_default_on_a_stale_cache(monkeypatch):
    """The live PROD symptom (consequence B): a carried-over cached model list without the
    stored default (z-ai/glm-4.7) must NOT swap the narrator to the first cached model
    (openai/gpt-5.6-luna-pro) — with no in-process refresh, the configured default stands."""
    model_routes, client = _default_chat_client(monkeypatch, {
        "default_endpoint_id": "", "default_model": "z-ai/glm-4.7",
    })
    _seed_single_openrouter_endpoint(
        cached=["openai/gpt-5.6-luna-pro", "openai/gpt-4o"])  # stale list; no glm entry
    model_routes._MODELS_LIVE_REFRESH.clear()  # no in-process refresh — cache age unknown

    body = client.get("/api/default-chat").json()
    assert body["model"] == "z-ai/glm-4.7", \
        f"a stale cache must never swap the configured narrator, got {body['model']!r}"


def test_default_chat_rederives_a_genuinely_dropped_model_on_a_fresh_cache(monkeypatch):
    """The (F) protection stands where it is trustworthy: with an in-process refresh on record,
    a stored default missing from the FRESH list re-derives (it would 404 mid-turn)."""
    model_routes, client = _default_chat_client(monkeypatch, {
        "default_endpoint_id": "ep-or", "default_model": "provider/renamed-away",
    })
    _seed_single_openrouter_endpoint(cached=["deepseek/deepseek-v4-pro", "openai/gpt-4o"])
    rk = model_routes._refresh_key("https://openrouter.ai/api/v1", "sk-live-test")
    model_routes._MODELS_LIVE_REFRESH.clear()
    model_routes._MODELS_LIVE_REFRESH[rk] = 1.0

    body = client.get("/api/default-chat").json()
    assert body["model"] == "deepseek/deepseek-v4-pro", \
        "a confirmed-fresh miss must still self-heal to a real chat model"
    model_routes._MODELS_LIVE_REFRESH.clear()


def test_default_chat_still_self_heals_an_image_default_without_a_fresh_cache(monkeypatch):
    """The image-model guard stays UNCONDITIONAL (an image model can never be the chat
    default) — the freshness gate applies only to the membership re-derive."""
    model_routes, client = _default_chat_client(monkeypatch, {
        "default_endpoint_id": "ep-or", "default_model": "google/gemini-3.1-flash-image",
    })
    _seed_single_openrouter_endpoint(
        cached=["google/gemini-3.1-flash-image", "deepseek/deepseek-v4-pro"])
    model_routes._MODELS_LIVE_REFRESH.clear()

    body = client.get("/api/default-chat").json()
    assert body["model"] == "deepseek/deepseek-v4-pro"

"""Owner ruling 2026-07-13 (live prod debug-bundle audit) — the OUT-OF-BOX default model is
NEVER an arbitrary first-available pick.

Live symptom: a fresh OOBE box resolved its chat default to whatever the provider list led
with (openai/gpt-5.6-luna-pro — "gpt luna") instead of the shipped narrator, and the fresh
OpenRouter endpoint presented its whole auto-discovered catalog ("22 models") as enabled.
Three seams still picked first-available; each is closed and pinned here:

  1. POST /api/model-endpoints (first-endpoint default seeding) — used to OVERWRITE the
     configured `default_model` with `_first_chat_model(model_ids)` whenever the just-probed
     catalog didn't show it, so an empty/partial probe silently PERSISTED an arbitrary model
     (or wiped the default to ""). The configured default now always wins; only an EMPTY
     configured default is seeded from the catalog.
  2. POST /api/session (no-model session creation) — used to jump straight to
     `_first_chat_model(ids) or ids[0]`, never consulting the configured default.
  3. Game-build endpoint curation — a fresh provider endpoint on a game build pins the
     game's model trio (narrator/utility/image from settings) and seeds the rest of the
     discovered catalog HIDDEN (reversible in the model manager), so the enabled set is the
     curated game set, not the whole catalog.

Also pinned: /api/default-chat keeps the configured default on an EMPTY cached list (the
stale-cache half is pinned in test_oobe_observability.py).

Roles only — model ids here are provider ids (app config), never cast material.
"""
import importlib
import json
import os

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

settings_mod = importlib.import_module("src.settings")

# The shipped OOB identities (the ADR 0016 set as ruled 2026-07-13).
_NARRATOR = "z-ai/glm-4.7"
_UTILITY = "qwen/qwen3.6-flash"
_IMAGE = "google/gemini-3.1-flash-image"
_ARBITRARY_FIRST = "openai/gpt-5.6-luna-pro"


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
    """Shared per-worker DB — never leave keyed enabled endpoints behind (they make the
    single-endpoint auto-default fire inside unrelated tests)."""
    _clear_endpoints()
    yield
    _clear_endpoints()


def _model_routes_client(monkeypatch, settings, probed):
    """A TestClient over the real model routes with an in-memory settings store and a
    stubbed provider probe (no network)."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    model_routes = importlib.import_module("routes.model_routes")
    er = importlib.import_module("src.endpoint_resolver")
    store = dict(settings)
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setattr(model_routes, "_load_settings", lambda: dict(store))
    monkeypatch.setattr(model_routes, "_save_settings", lambda s: store.update(s))
    # The curation block reads the game trio via src.settings.get_setting at call time —
    # pin it to THIS harness store (the per-worker real settings.json is shared across test
    # files under xdist, so an un-pinned read is order-dependent).
    monkeypatch.setattr(settings_mod, "get_setting",
                        lambda key, default=None: store.get(key, default))
    monkeypatch.setattr(model_routes, "_probe_endpoint", lambda *a, **k: list(probed))
    monkeypatch.setattr(model_routes, "_ping_endpoint",
                        lambda *a, **k: {"reachable": True, "error": None})
    monkeypatch.setattr(er, "resolve_url", lambda u: u)
    app = FastAPI()
    app.include_router(model_routes.setup_model_routes(object()))
    return model_routes, TestClient(app, raise_server_exceptions=False), store


def _add_openrouter(client, **extra):
    form = {"base_url": "https://openrouter.ai/api/v1", "api_key": "sk-live-test",
            "name": "OpenRouter", "require_models": "true"}
    form.update(extra)
    res = client.post("/api/model-endpoints", data=form)
    assert res.status_code == 200, res.text
    return res.json()


def _endpoint_row(ep_id):
    from core.database import SessionLocal, ModelEndpoint
    db = SessionLocal()
    try:
        return db.query(ModelEndpoint).filter(ModelEndpoint.id == ep_id).first()
    finally:
        db.close()


# ═══════════════════════════════════════════════════════════════════════════════════════
# 1. Endpoint creation — the configured default_model is NEVER overwritten by a probe
# ═══════════════════════════════════════════════════════════════════════════════════════

def test_create_endpoint_keeps_configured_default_when_probe_lacks_it(monkeypatch):
    """A probed catalog WITHOUT the configured default (the partial/stale-probe shape) must
    not swap the persisted default to the first-listed model (the 'luna' persistence bug)."""
    _mr, client, store = _model_routes_client(
        monkeypatch,
        {"default_endpoint_id": "", "default_model": _NARRATOR},
        probed=[_ARBITRARY_FIRST, "openai/gpt-4o"],
    )
    monkeypatch.setattr(settings_mod, "game_build_enabled", lambda: False)
    body = _add_openrouter(client)
    assert store["default_endpoint_id"] == body["id"]
    assert store["default_model"] == _NARRATOR, (
        f"the configured default must survive a probe that lacks it, got {store['default_model']!r}"
    )


def test_create_endpoint_keeps_configured_default_on_an_empty_probe(monkeypatch):
    """The exact OOBE shape: the probe returns NOTHING (slow/unreachable). The old code wiped
    default_model to '' here — it must stay the shipped narrator."""
    _mr, client, store = _model_routes_client(
        monkeypatch,
        {"default_endpoint_id": "", "default_model": _NARRATOR},
        probed=[],
    )
    monkeypatch.setattr(settings_mod, "game_build_enabled", lambda: False)
    # An empty probe with require_models would 400 — use the plain add path.
    res = client.post("/api/model-endpoints", data={
        "base_url": "https://openrouter.ai/api/v1", "api_key": "sk-live-test",
        "name": "OpenRouter", "skip_probe": "true"})
    assert res.status_code == 200, res.text
    assert store["default_model"] == _NARRATOR, (
        f"an empty probe must never wipe/replace the configured default, got {store['default_model']!r}"
    )


def test_create_endpoint_seeds_only_an_EMPTY_default_from_the_catalog(monkeypatch):
    """Fill-empty stays: with NO configured default, the first CHAT model seeds it (that is
    seeding an empty value, not swapping a configured one)."""
    _mr, client, store = _model_routes_client(
        monkeypatch,
        {"default_endpoint_id": "", "default_model": ""},
        probed=[_ARBITRARY_FIRST, "openai/gpt-4o"],
    )
    monkeypatch.setattr(settings_mod, "game_build_enabled", lambda: False)
    _add_openrouter(client)
    assert store["default_model"] == _ARBITRARY_FIRST  # first CHAT model of the catalog


# ═══════════════════════════════════════════════════════════════════════════════════════
# 2. Game-build curation — a fresh provider endpoint pins the game trio, hides the rest
# ═══════════════════════════════════════════════════════════════════════════════════════

_CATALOG = [_ARBITRARY_FIRST, "openai/gpt-4o", _NARRATOR, _UTILITY, _IMAGE,
            "mistralai/mistral-large", "meta-llama/llama-4-70b"]


def _curation_settings():
    return {"default_endpoint_id": "", "default_model": _NARRATOR,
            "utility_model": _UTILITY, "image_model": _IMAGE}


def test_game_build_curation_pins_the_game_trio_and_hides_the_rest(monkeypatch):
    _mr, client, _store = _model_routes_client(monkeypatch, _curation_settings(), probed=_CATALOG)
    monkeypatch.setattr(settings_mod, "game_build_enabled", lambda: True)
    body = _add_openrouter(client)
    row = _endpoint_row(body["id"])
    pinned = json.loads(row.pinned_models or "[]")
    hidden = json.loads(row.hidden_models or "[]")
    assert set(pinned) == {_NARRATOR, _UTILITY, _IMAGE}, f"pinned must be the game trio, got {pinned}"
    assert set(hidden) == set(_CATALOG) - {_NARRATOR, _UTILITY, _IMAGE}, (
        "everything else discovered must seed HIDDEN (reversible in the model manager)"
    )
    # The response (what the add-endpoint UI renders/selects from) shows ONLY the curated set.
    assert set(body["models"]) == {_NARRATOR, _UTILITY, _IMAGE}, (
        f"the enabled presentation must be the curated game set, got {body['models']}"
    )


def test_game_build_curation_resolves_the_enabled_set_to_the_game_models(monkeypatch):
    """End-to-end over the resolver: after curation, the endpoint's ENABLED models are the
    trio — so any first-enabled-chat floor lands on the narrator, never the catalog head."""
    _mr, client, _store = _model_routes_client(monkeypatch, _curation_settings(), probed=_CATALOG)
    monkeypatch.setattr(settings_mod, "game_build_enabled", lambda: True)
    body = _add_openrouter(client)
    er = importlib.import_module("src.endpoint_resolver")
    row = _endpoint_row(body["id"])
    enabled = er._endpoint_enabled_models(row)
    assert set(enabled) == {_NARRATOR, _UTILITY, _IMAGE}
    assert er._first_chat_model(enabled) in (_NARRATOR, _UTILITY), (
        "the first-enabled-CHAT floor must land on a game chat model (never the image model, "
        "never the hidden catalog head)"
    )


def test_no_curation_off_the_game_build(monkeypatch):
    _mr, client, _store = _model_routes_client(monkeypatch, _curation_settings(), probed=_CATALOG)
    monkeypatch.setattr(settings_mod, "game_build_enabled", lambda: False)
    body = _add_openrouter(client)
    row = _endpoint_row(body["id"])
    assert not row.pinned_models and not row.hidden_models, \
        "curation is game-build only — the full workspace keeps the whole catalog enabled"
    assert set(body["models"]) == set(_CATALOG)


def test_no_curation_when_the_catalog_lacks_the_narrator(monkeypatch):
    """Fail-open: an unknown/local provider that doesn't serve the narrator keeps today's
    behavior byte-identical (no pins, no hides)."""
    _mr, client, _store = _model_routes_client(
        monkeypatch, _curation_settings(), probed=[_ARBITRARY_FIRST, "openai/gpt-4o"])
    monkeypatch.setattr(settings_mod, "game_build_enabled", lambda: True)
    body = _add_openrouter(client)
    row = _endpoint_row(body["id"])
    assert not row.pinned_models and not row.hidden_models


def test_no_curation_over_an_explicit_pinned_models_form_value(monkeypatch):
    """An admin's explicit pinned_models is respected — auto-curation never overrides it."""
    _mr, client, _store = _model_routes_client(monkeypatch, _curation_settings(), probed=_CATALOG)
    monkeypatch.setattr(settings_mod, "game_build_enabled", lambda: True)
    body = _add_openrouter(client, pinned_models="openai/gpt-4o")
    row = _endpoint_row(body["id"])
    assert json.loads(row.pinned_models or "[]") == ["openai/gpt-4o"]
    assert not row.hidden_models


def test_no_curation_without_a_probe(monkeypatch):
    """skip_probe (the golden driver's shape) discovers nothing ⇒ nothing to curate — the
    golden record/replay endpoint stays byte-identical."""
    _mr, client, _store = _model_routes_client(monkeypatch, _curation_settings(), probed=[])
    monkeypatch.setattr(settings_mod, "game_build_enabled", lambda: True)
    res = client.post("/api/model-endpoints", data={
        "base_url": "https://openrouter.ai/api/v1", "api_key": "sk-live-test",
        "name": "golden-like", "skip_probe": "true"})
    assert res.status_code == 200
    row = _endpoint_row(res.json()["id"])
    assert not row.pinned_models and not row.hidden_models


# ═══════════════════════════════════════════════════════════════════════════════════════
# 3. /api/default-chat — an EMPTY cached list keeps the configured default
# ═══════════════════════════════════════════════════════════════════════════════════════

def test_default_chat_keeps_configured_default_on_an_empty_cached_list(monkeypatch):
    """The fresh-OOBE shape: the endpoint row exists but its cached_models is EMPTY — the
    configured default must resolve, never '' and never a swapped pick."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from core.database import SessionLocal, ModelEndpoint
    model_routes = importlib.import_module("routes.model_routes")
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setattr(model_routes, "_load_settings",
                        lambda: {"default_endpoint_id": "ep-or", "default_model": _NARRATOR})
    db = SessionLocal()
    try:
        db.query(ModelEndpoint).delete()
        db.add(ModelEndpoint(id="ep-or", name="OpenRouter",
                             base_url="https://openrouter.ai/api/v1",
                             api_key="sk-live-test", is_enabled=True, model_type="llm",
                             cached_models=None))
        db.commit()
    finally:
        db.close()
    app = FastAPI()
    app.include_router(model_routes.setup_model_routes(object()))
    client = TestClient(app, raise_server_exceptions=False)
    body = client.get("/api/default-chat").json()
    assert body["model"] == _NARRATOR, (
        f"an empty cached list must keep the configured default, got {body['model']!r}"
    )


# ═══════════════════════════════════════════════════════════════════════════════════════
# 4. POST /api/session with no model — the configured default wins over first-available
# ═══════════════════════════════════════════════════════════════════════════════════════

class _StubSessionManager:
    def __init__(self):
        self.created = {}

    def create_session(self, session_id, name, endpoint_url, model, rag, owner):
        import types
        s = types.SimpleNamespace(id=session_id, name=name, endpoint_url=endpoint_url,
                                  model=model, rag=rag, owner=owner, headers=None)
        self.created[session_id] = s
        return s


def _session_client(monkeypatch, live_ids, cfg_model=_NARRATOR):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    session_routes = importlib.import_module("routes.session_routes")
    chat_routes = importlib.import_module("routes.chat_routes")
    llm_core = importlib.import_module("src.llm_core")
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setattr(llm_core, "list_model_ids",
                        lambda url, timeout=None, headers=None: list(live_ids))
    monkeypatch.setattr(chat_routes, "_default_chat_target",
                        lambda owner: ("ep-or", cfg_model))
    sm = _StubSessionManager()
    # `session_routes.router` is a module-global APIRouter that every setup_session_routes() call appends to, so
    # without a fresh one these handlers outlived the test and answered a LATER test's requests first.
    from fastapi import APIRouter
    monkeypatch.setattr(session_routes, "router", APIRouter(prefix="/api", tags=["sessions"]))
    app = FastAPI()
    app.include_router(session_routes.setup_session_routes(sm, {"REQUEST_TIMEOUT": 2}))
    return TestClient(app, raise_server_exceptions=False), sm


def test_session_with_no_model_prefers_the_configured_default(monkeypatch):
    """The live symptom's seam: a model-less session on an endpoint that serves the configured
    default must bind THE default — never the first-listed model (luna)."""
    client, _sm = _session_client(
        monkeypatch, live_ids=[_ARBITRARY_FIRST, "openai/gpt-4o", _NARRATOR])
    res = client.post("/api/session", data={"endpoint_url": "https://openrouter.ai/api/v1"})
    assert res.status_code == 200, res.text
    assert res.json()["model"] == _NARRATOR, (
        f"the configured default must win over first-available, got {res.json()['model']!r}"
    )


def test_session_with_no_model_falls_back_when_default_is_not_served(monkeypatch):
    """A custom endpoint that genuinely doesn't serve the configured default keeps the
    first-CHAT-model floor (its live list is authoritative — never a dead bind)."""
    client, _sm = _session_client(
        monkeypatch, live_ids=[_ARBITRARY_FIRST, "openai/gpt-4o"])
    res = client.post("/api/session", data={"endpoint_url": "http://local.example/v1"})
    assert res.status_code == 200, res.text
    assert res.json()["model"] == _ARBITRARY_FIRST


def test_session_with_no_model_matches_the_default_by_basename(monkeypatch):
    """A provider that lists the same model under a different prefix still binds the
    configured identity (basename match), never an unrelated first pick."""
    client, _sm = _session_client(
        monkeypatch, live_ids=[_ARBITRARY_FIRST, "zai-org/glm-4.7"], cfg_model=_NARRATOR)
    res = client.post("/api/session", data={"endpoint_url": "http://mirror.example/v1"})
    assert res.status_code == 200, res.text
    assert res.json()["model"] == "zai-org/glm-4.7"


def test_session_with_explicit_model_is_untouched(monkeypatch):
    """An explicit model choice never gets 'corrected' to the default."""
    client, _sm = _session_client(
        monkeypatch, live_ids=[_ARBITRARY_FIRST, "openai/gpt-4o", _NARRATOR])
    res = client.post("/api/session", data={
        "endpoint_url": "https://openrouter.ai/api/v1", "model": "openai/gpt-4o"})
    assert res.status_code == 200, res.text
    assert res.json()["model"] == "openai/gpt-4o"


def test_session_rejects_an_embeddings_only_endpoint(monkeypatch):
    """CodeRabbit (Major): an endpoint that serves only NON-CHAT models — e.g. an embeddings-only
    provider — must be refused with 400, never bind a chat-INCAPABLE model. `_first_chat_model`'s
    tier-2 'first non-image' fallback would otherwise return the embeddings id (non-image but
    non-chat), which an image-only guard let through. The configured default is NOT served here,
    so this exercises the fallback branch."""
    client, _sm = _session_client(
        monkeypatch, live_ids=["text-embedding-3-large", "text-embedding-ada-002"])
    res = client.post("/api/session", data={"endpoint_url": "http://embeddings.example/v1"})
    assert res.status_code == 400, res.text
    assert "no chat-capable model" in res.text
    assert not _sm.created, "no session row may be created for a chat-incapable endpoint"


def test_session_rejects_a_mixed_nonchat_endpoint_with_no_chat_model(monkeypatch):
    """A grab-bag of non-chat classes (embeddings + tts + rerank + an image model) with NO chat
    model must still 400 — the full non-chat class is filtered, not just image models."""
    client, _sm = _session_client(
        monkeypatch, live_ids=["tts-1", "rerank-english-v3", "text-embedding-ada-002",
                               "google/gemini-3.1-flash-image"])
    res = client.post("/api/session", data={"endpoint_url": "http://mixed.example/v1"})
    assert res.status_code == 400, res.text
    assert "no chat-capable model" in res.text
    assert not _sm.created, "no session row may be created for a chat-incapable endpoint"


def test_session_still_binds_a_real_chat_model_beside_nonchat_ones(monkeypatch):
    """The guard must NOT over-reject: an endpoint that lists embeddings/tts BUT also a real chat
    model still creates a session on the CHAT model (never the embeddings id)."""
    client, _sm = _session_client(
        monkeypatch, live_ids=["text-embedding-ada-002", "tts-1", _NARRATOR])
    res = client.post("/api/session", data={"endpoint_url": "http://mixed.example/v1"})
    assert res.status_code == 200, res.text
    # cfg default (_NARRATOR) is served here ⇒ it binds; either way the model must be chat-capable.
    assert res.json()["model"] == _NARRATOR


def test_session_configured_default_that_is_nonchat_is_ignored(monkeypatch):
    """Belt: even if the configured default were somehow a NON-CHAT id (embeddings), the route must
    not bind it — it falls through to the first chat model on the endpoint."""
    client, _sm = _session_client(
        monkeypatch, live_ids=["text-embedding-ada-002", _NARRATOR],
        cfg_model="text-embedding-ada-002")
    res = client.post("/api/session", data={"endpoint_url": "http://mixed.example/v1"})
    assert res.status_code == 200, res.text
    assert res.json()["model"] == _NARRATOR

"""The post-OOBE-reset default-endpoint brick (PROD blocker, 2026-07-12) — fixed end to end.

Live evidence (debug bundle, schema 2): after a factory/OOBE reset the store held exactly ONE
enabled OpenRouter endpoint WITH an API key, `default_model` = the OOB "z-ai/glm-4.7", but the
default-endpoint DESIGNATION was gone (`defaultEndpointId: null` / `defaultResolved: null`) —
the #860 reset deliberately drops `default_endpoint_id`, relying on a "resolution binds the
empty default to the first enabled endpoint" behavior that `endpoint_resolver.resolve_endpoint`
NEVER had. Every per-call-class utility resolution then failed ("no model resolved for the
cast-genesis/-identity/-authoring call class"), and the strict 0116 enrichment policy —
correctly — refused game creation. A second, independent brick: `resolve_endpoint`'s
ModelEndpoint query owner-scoped with `include_shared=False` and NO admin exemption, so a
preserved endpoint whose owner stamp went stale across the reset (accounts are wiped and
recreated) could not resolve even with the designation restored by hand.

The fixes under test:
  1. SHIP GATE — the single-endpoint auto-default in `resolve_endpoint`: designation
     null/dangling + EXACTLY ONE enabled+keyed non-image endpoint ⇒ bind to it (stored
     `default_model` honored). Never fires with 2+ candidates or when a caller fallback exists.
  2. Owner-scope: admins unscoped; everyone else own + shared/null-owner rows (the
     `ai_interaction._resolve_model` precedent), in `resolve_endpoint` + `resolve_endpoint_by_id`.
  3. `scripts/oobe_reset.py` preserves/derives the `default_endpoint_id` designation and
     re-owns preserved endpoint rows to shared (accounts are wiped, so every owner stamp is
     stale by construction). Model SELECTIONS still reset per #860.
  4. The createCharacter no-model refusal carries an operator-actionable message + a
     structured `refusalKind`, and the agent loop surfaces it as a production note instead of
     letting the model stall in fiction.

Roles only — no houseguest/player names; "rhino" here is an ACCOUNT username from the live
bundle used as an opaque owner key.
"""

import importlib
import importlib.util
import json
import os
import sqlite3

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

endpoint_resolver = importlib.import_module("src.endpoint_resolver")
settings_mod = importlib.import_module("src.settings")
auth_helpers = importlib.import_module("src.auth_helpers")
enrichment = importlib.import_module("src.enrichment_policy")


# ── store construction: EXACTLY the live post-reset state ────────────────────────────────

def _seed_single_openrouter_endpoint(ep_id="ep-or", *, api_key="sk-live-test", owner=None,
                                     enabled=True, model_type="llm"):
    """One enabled endpoint row, API key present, no is_default anywhere (the ModelEndpoint
    schema has no such column — the designation lives ONLY in settings)."""
    from core.database import SessionLocal, ModelEndpoint
    db = SessionLocal()
    try:
        db.query(ModelEndpoint).delete()  # exactly ONE row, like the live bundle
        db.add(ModelEndpoint(
            id=ep_id, name="OpenRouter", base_url="https://openrouter.ai/api/v1",
            api_key=api_key, is_enabled=enabled, model_type=model_type, owner=owner,
        ))
        db.commit()
    finally:
        db.close()


def _add_endpoint(ep_id, *, api_key="sk-2", owner=None, enabled=True, model_type="llm"):
    from core.database import SessionLocal, ModelEndpoint
    db = SessionLocal()
    try:
        db.query(ModelEndpoint).filter(ModelEndpoint.id == ep_id).delete()
        db.add(ModelEndpoint(
            id=ep_id, name=f"EP {ep_id}", base_url="https://api.example/v1",
            api_key=api_key, is_enabled=enabled, model_type=model_type, owner=owner,
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
    """The per-worker test DB is SHARED across files: a keyed enabled endpoint left behind by
    these tests would make the (now real) single-endpoint auto-default fire inside UNRELATED
    tests (e.g. the zeitgeist/authoring paths engaging for real in the portrait-order test).
    Clear the table on both sides of every test here."""
    _clear_endpoints()
    yield
    _clear_endpoints()


@pytest.fixture()
def post_reset_settings(monkeypatch):
    """The live post-reset settings state: settings.json is {} + operational flags, so the
    MERGE over DEFAULT_SETTINGS is what loads — `default_endpoint_id` EMPTY,
    `default_model` = the OOB z-ai/glm-4.7. Per-user prefs are absent (accounts recreated)."""
    merged = dict(settings_mod.DEFAULT_SETTINGS)
    # The OOB default is DeepSeek now (PO ruling 2026-11-02); these tests model an install that is
    # CONFIGURED for OpenRouter's narrator/utility pair (OpenRouter stays selectable), so pin it.
    merged["default_model"] = "z-ai/glm-4.7"
    merged["utility_model"] = "qwen/qwen3.6-27b"
    monkeypatch.setattr(settings_mod, "load_settings", lambda: dict(merged))
    monkeypatch.setattr(settings_mod, "get_setting",
                        lambda key, default=None: merged.get(key, default))
    # No per-user prefs survive a reset:
    import routes.prefs_routes as prefs_routes
    monkeypatch.setattr(prefs_routes, "_load_for_user", lambda user: {})
    return merged


@pytest.fixture()
def rhino_is_admin(monkeypatch):
    """The recreated post-reset account is an admin (the live bundle's 'rhino')."""
    monkeypatch.setattr(auth_helpers, "is_admin_user", lambda user: user == "rhino")


# ═══════════════════════════════════════════════════════════════════════════════════════
# SHIP GATE — the exact live-bundle store state must resolve at RUNTIME with no manual fix
# ═══════════════════════════════════════════════════════════════════════════════════════

def test_ship_gate_single_keyed_endpoint_resolves_for_recreated_admin(
        post_reset_settings, rhino_is_admin):
    """settings: default_endpoint_id ABSENT, default_model=z-ai/glm-4.7; ONE enabled keyed
    OpenRouter row (owner stamp stale — not 'rhino'); recreated admin user. The single-endpoint
    auto-default MUST bind resolution to that endpoint — no settings edit, no UI toggle."""
    _seed_single_openrouter_endpoint(owner="pre-reset-ghost")

    url, model, headers = endpoint_resolver.resolve_endpoint("default", owner="rhino")
    assert url and url.endswith("/chat/completions"), f"must bind the sole keyed endpoint, got {url!r}"
    assert model == "z-ai/glm-4.7", "the stored OOB default_model must be honored, never re-derived"
    assert isinstance(headers, dict) and headers.get("Authorization", "").startswith("Bearer ")


def test_ship_gate_utility_class_resolves_too(post_reset_settings, rhino_is_admin):
    """The per-call-class chain (utility → default) that cast-genesis/-identity/-authoring ride.
    2026-07-13: the unset utility ENDPOINT rides the default endpoint, but the configured
    utility MODEL (the ADR 0016 qwen tier) stays authoritative — it no longer collapses to
    the narrator model out of the box."""
    _seed_single_openrouter_endpoint(owner=None)
    url, model, _h = endpoint_resolver.resolve_endpoint("utility", owner="rhino")
    assert url and model == "qwen/qwen3.6-27b"


def test_ship_gate_preflight_unwired_is_empty(post_reset_settings, rhino_is_admin, run):
    """`enrichment_policy.preflight_unwired` must return [] on the live-bundle store state —
    the real resolvers (`resolve_authoring_llm_fn` + `_resolve_llm_fn`), no stubs."""
    _seed_single_openrouter_endpoint(owner="pre-reset-ghost")
    unwired = run(enrichment.preflight_unwired("rhino"))
    assert unwired == [], f"no class may read as unwired on the live store state, got {unwired}"


def test_ship_gate_create_character_is_not_refused(post_reset_settings, rhino_is_admin,
                                                   monkeypatch, run):
    """STRICT policy + the exact live store state ⇒ createCharacter must NOT be refused."""
    monkeypatch.setenv("ORWELL_ENRICHMENT_POLICY", "strict")
    _seed_single_openrouter_endpoint(owner="pre-reset-ghost")

    oe = importlib.import_module("src.orwell_engine")
    ti = importlib.import_module("src.tool_implementations")
    calls = {"create": 0}

    async def fake_create(*a, **k):
        calls["create"] += 1
        return {"started": True, "house": [], "portraitPrompts": []}

    async def fake_state(*a, **k):
        return {"started": False}
    monkeypatch.setattr(oe, "create_character", fake_create)
    monkeypatch.setattr(oe, "get_game_state", fake_state)
    cid = importlib.import_module("src.orwell_cast_identity")
    monkeypatch.setattr(cid, "kickoff_identity", lambda *a, **k: None)
    zg = importlib.import_module("src.orwell_zeitgeist")
    monkeypatch.setattr(zg, "kickoff_capture", lambda *a, **k: None)

    # #1568 — stub the 0116 cast-genesis seam so this ship-gate check NEVER dials openrouter.ai.
    # do_create_character warms the cast (pre_seed_cast) then AWAITS genesis inline; with the seeded
    # live OpenRouter endpoint, real genesis resolves that endpoint and makes a network completion
    # (the CI real-call leak). Stub the pre-warm to a deterministic roster and genesis to a
    # deterministic (no-_resolve_llm_fn, no-network) success, so the strict pre-finalize gate passes
    # against the stub — IDENTICAL with or without a network/engine, and regardless of the
    # enrichment_policy default. The refusal decision under test rides preflight_unwired (real, resolves
    # the seeded endpoint ⇒ every class wired) + genesis strict_failed (False after a clean run).
    genesis = importlib.import_module("src.orwell_cast_genesis")
    genesis.reset_state("rhino")   # no stale strict-failed latch from a sibling test in this worker

    async def fake_pre_seed(*a, **k):
        return {"warmed": True, "seed": 7, "house": [{"id": "npc:1"}], "portraitPrompts": []}

    async def fake_run_genesis(*a, **k):
        return {"committed": 1}    # deterministic success — no _resolve_llm_fn, no network
    monkeypatch.setattr(oe, "pre_seed_cast", fake_pre_seed)
    monkeypatch.setattr(genesis, "run_genesis", fake_run_genesis)

    enrichment.clear_failures("rhino")
    res = run(ti.do_create_character('{"playerName":"P"}', owner="rhino"))
    assert res.get("exit_code") == 0, f"creation must NOT be refused on this store state: {res}"
    assert calls["create"] == 1
    assert res.get("refusalKind") is None


def test_orw260_a_failed_backstory_authoring_run_blocks_the_start_once_loudly(post_reset_settings, rhino_is_admin,
                                                                           monkeypatch, run):
    """ORW-260 (Ryne, BDD card 30, option B): the deeper backstories are REQUIRED like the cast skeleton. Strict policy + a latched authoring failure => casting finalize is
    refused BEFORE the engine starts (no fallback cast); the refusal is one-shot (the retry re-runs authoring instead of deadlocking on a stale latch)."""
    monkeypatch.setenv("ORWELL_ENRICHMENT_POLICY", "strict")
    monkeypatch.delenv("ORWELL_ALLOW_FLOOR_START", raising=False)
    _seed_single_openrouter_endpoint(owner="pre-reset-ghost")
    oe = importlib.import_module("src.orwell_engine")
    ti = importlib.import_module("src.tool_implementations")
    authoring = importlib.import_module("src.orwell_cast_authoring")
    genesis = importlib.import_module("src.orwell_cast_genesis")
    calls = {"create": 0}

    async def fake_create(*a, **k):
        calls["create"] += 1
        return {"started": True, "house": [], "portraitPrompts": []}

    async def fake_state(*a, **k):
        return {"started": False}

    async def fake_pre_seed(*a, **k):
        return {"warmed": True, "seed": 7, "house": [{"id": "npc:1"}], "portraitPrompts": []}

    async def fake_run_genesis(*a, **k):
        return {"committed": 1}
    monkeypatch.setattr(oe, "create_character", fake_create)
    monkeypatch.setattr(oe, "get_game_state", fake_state)
    monkeypatch.setattr(oe, "pre_seed_cast", fake_pre_seed)
    monkeypatch.setattr(genesis, "run_genesis", fake_run_genesis)
    monkeypatch.setattr(importlib.import_module("src.orwell_cast_identity"), "kickoff_identity", lambda *a, **k: None)
    monkeypatch.setattr(importlib.import_module("src.orwell_zeitgeist"), "kickoff_capture", lambda *a, **k: None)
    genesis.reset_state("rhino")
    enrichment.clear_failures("rhino")

    authoring.mark_strict_failed("rhino")   # the deeper-backstory lane ended on the floor
    res = run(ti.do_create_character('{"playerName":"P"}', owner="rhino"))
    assert res.get("exit_code") == 1, f"a failed backstory run must block the start: {res}"
    assert calls["create"] == 0, "the engine must NOT start on the fallback"
    assert "backstories" in res.get("error", "")
    assert any(f.get("callClass") == "cast-authoring" for f in enrichment.failures("rhino")), "and it is a loud ledger entry"
    assert authoring.strict_failed("rhino") is False, "one-shot: the retry is not deadlocked on a stale latch"
    # the world snapshot / off-screen detail stay fail-soft: nothing about them blocks (they never touch this latch)
    res2 = run(ti.do_create_character('{"playerName":"P"}', owner="rhino"))
    assert res2.get("exit_code") == 0 and calls["create"] == 1


def test_ship_gate_non_admin_user_with_shared_endpoint_also_resolves(post_reset_settings,
                                                                     monkeypatch):
    """Belt for the non-admin variant: a preserved NULL-owner (shared) endpoint must resolve
    for a plain recreated user too (include_shared scoping)."""
    monkeypatch.setattr(auth_helpers, "is_admin_user", lambda user: False)
    _seed_single_openrouter_endpoint(owner=None)
    url, model, _h = endpoint_resolver.resolve_endpoint("default", owner="someone-new")
    assert url and model == "z-ai/glm-4.7"


# ── the fallback's guardrails: it must NOT fire outside the unambiguous case ─────────────

def test_auto_default_does_not_fire_with_two_keyed_endpoints(post_reset_settings, rhino_is_admin):
    _seed_single_openrouter_endpoint(owner=None)
    _add_endpoint("ep-second", api_key="sk-2")
    url, model, _h = endpoint_resolver.resolve_endpoint("default", owner="rhino")
    assert url is None and model is None, "ambiguous (2 keyed endpoints) must NOT auto-bind"


def test_auto_default_does_not_fire_without_an_api_key(post_reset_settings, rhino_is_admin):
    _seed_single_openrouter_endpoint(api_key=None)
    url, model, _h = endpoint_resolver.resolve_endpoint("default", owner="rhino")
    assert url is None and model is None


def test_auto_default_skips_image_only_endpoints(post_reset_settings, rhino_is_admin):
    """An image provider (model_type='image') can never become the chat/utility default; but a
    single keyed LLM endpoint beside it is still unambiguous."""
    _seed_single_openrouter_endpoint(model_type="image")
    url, model, _h = endpoint_resolver.resolve_endpoint("default", owner="rhino")
    assert url is None
    _add_endpoint("ep-llm", api_key="sk-llm", model_type="llm")
    url, model, _h = endpoint_resolver.resolve_endpoint("default", owner="rhino")
    assert url and model == "z-ai/glm-4.7"


def test_auto_default_never_overrides_a_caller_fallback(post_reset_settings, rhino_is_admin):
    """A caller-supplied usable fallback (e.g. the active session model) still wins — the
    auto-default only rescues a DEAD END."""
    _seed_single_openrouter_endpoint()
    url, model, headers = endpoint_resolver.resolve_endpoint(
        "task", fallback_url="http://session/v1/chat/completions",
        fallback_model="session-model", fallback_headers={"h": "1"}, owner="rhino")
    assert (url, model) == ("http://session/v1/chat/completions", "session-model")


def test_configured_designation_is_untouched(post_reset_settings, rhino_is_admin, monkeypatch):
    """No behavior change when a default endpoint IS configured: the configured id wins even
    with a second keyed endpoint present."""
    merged = post_reset_settings
    _seed_single_openrouter_endpoint("ep-or", owner=None)
    _add_endpoint("ep-other", api_key="sk-2")
    merged["default_endpoint_id"] = "ep-other"
    merged["default_model"] = "some/model"
    url, model, _h = endpoint_resolver.resolve_endpoint("default", owner="rhino")
    assert url == "https://api.example/v1/chat/completions"
    assert model == "some/model"


def test_dangling_designation_falls_back_to_the_sole_keyed_endpoint(post_reset_settings,
                                                                    rhino_is_admin):
    """A default_endpoint_id pointing at a deleted row is the same brick — the auto-default
    must rescue it when exactly one keyed endpoint exists."""
    merged = post_reset_settings
    merged["default_endpoint_id"] = "ep-deleted-long-ago"
    _seed_single_openrouter_endpoint("ep-or")
    url, model, _h = endpoint_resolver.resolve_endpoint("default", owner="rhino")
    assert url and url.endswith("/chat/completions")
    assert model == "z-ai/glm-4.7"


# ── owner-scope hardening (the second latent brick) ──────────────────────────────────────

def test_explicit_designation_resolves_shared_row_for_non_admin(post_reset_settings, monkeypatch):
    """UI make-default → resolve: the settings key points at a NULL-owner (shared) endpoint;
    a non-admin caller must still resolve it (include_shared), matching the picker's read rules."""
    monkeypatch.setattr(auth_helpers, "is_admin_user", lambda user: False)
    merged = post_reset_settings
    _seed_single_openrouter_endpoint("ep-or", owner=None)
    merged["default_endpoint_id"] = "ep-or"
    url, model, _h = endpoint_resolver.resolve_endpoint("default", owner="someone-new")
    assert url and model == "z-ai/glm-4.7"


def test_explicit_designation_resolves_stale_owner_row_for_admin(post_reset_settings,
                                                                 rhino_is_admin):
    """Post-reset recreated ADMIN + a preserved endpoint whose owner stamp is stale: the
    explicit designation must resolve (admins manage the global pool — unscoped)."""
    merged = post_reset_settings
    _seed_single_openrouter_endpoint("ep-or", owner="pre-reset-ghost")
    merged["default_endpoint_id"] = "ep-or"
    url, model, _h = endpoint_resolver.resolve_endpoint("default", owner="rhino")
    assert url and model == "z-ai/glm-4.7"


def test_non_admin_still_cannot_resolve_another_users_owned_row(post_reset_settings, monkeypatch):
    """The security floor stands: another user's OWNED row (non-null, different owner) never
    resolves for a non-admin — not via the designation, not via the auto-default."""
    monkeypatch.setattr(auth_helpers, "is_admin_user", lambda user: False)
    merged = post_reset_settings
    _seed_single_openrouter_endpoint("ep-or", owner="somebody-else")
    merged["default_endpoint_id"] = "ep-or"
    url, model, _h = endpoint_resolver.resolve_endpoint("default", owner="not-the-owner")
    assert url is None and model is None


def test_resolve_endpoint_by_id_allows_shared_rows(post_reset_settings, monkeypatch):
    monkeypatch.setattr(auth_helpers, "is_admin_user", lambda user: False)
    _seed_single_openrouter_endpoint("ep-or", owner=None)
    resolved = endpoint_resolver.resolve_endpoint_by_id("ep-or", "z-ai/glm-4.7",
                                                        owner="someone-new")
    assert resolved is not None and resolved[1] == "z-ai/glm-4.7"


# ═══════════════════════════════════════════════════════════════════════════════════════
# oobe_reset.py — the designation survives the reset (root fix) + endpoints are re-owned
# ═══════════════════════════════════════════════════════════════════════════════════════

_HELPER = os.path.join(FRONTEND, "scripts", "oobe_reset.py")


def _load_helper(monkeypatch, tmp_path):
    db = tmp_path / "app.db"
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db}")
    spec = importlib.util.spec_from_file_location("oobe_reset_designation", _HELPER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod, db


def _seed_reset_store(db_path, settings_path, *, endpoints, settings):
    conn = sqlite3.connect(db_path)
    conn.execute(
        "CREATE TABLE model_endpoints (id TEXT, name TEXT, base_url TEXT, api_key TEXT, "
        "model_type TEXT, is_enabled INTEGER, owner TEXT)")
    for row in endpoints:
        conn.execute("INSERT INTO model_endpoints VALUES (?,?,?,?,?,?,?)", row)
    conn.execute("CREATE TABLE sessions (id TEXT)")  # must be wiped
    conn.execute("INSERT INTO sessions VALUES ('s1')")
    conn.commit()
    conn.close()
    with open(settings_path, "w", encoding="utf-8") as f:
        json.dump(settings, f)


def test_reset_preserves_the_default_endpoint_designation_end_to_end(monkeypatch, tmp_path):
    """An endpoint marked default (settings `default_endpoint_id`) BEFORE the reset stays the
    default AFTER: the key survives, still points at the surviving row, and the model
    SELECTIONS still reset to the OOB defaults (#860 intact)."""
    mod, db = _load_helper(monkeypatch, tmp_path)
    setp = tmp_path / "settings.json"
    _seed_reset_store(
        str(db), str(setp),
        endpoints=[("ep-or", "OpenRouter", "https://openrouter.ai/api/v1",
                    "enc:CIPHER", "llm", 1, "rhino")],
        settings={"default_endpoint_id": "ep-or", "default_model": "sakana/fugu-ultra",
                  "image_gen_enabled": True, "theme": "midnight"})

    mod.reset_frontend_store()

    kept = json.loads(setp.read_text())
    assert kept.get("default_endpoint_id") == "ep-or", \
        "the default-endpoint DESIGNATION must survive the reset (it has no other home)"
    # #860 stands: the model SELECTIONS still reset (the stale pick never rides across).
    assert "default_model" not in kept
    assert "sakana/fugu-ultra" not in json.dumps(kept)
    assert "theme" not in kept
    # And the designation resolves: the row it points at survived the rebuild.
    conn = sqlite3.connect(str(db))
    ids = [r[0] for r in conn.execute("SELECT id FROM model_endpoints").fetchall()]
    conn.close()
    assert kept["default_endpoint_id"] in ids


def test_reset_derives_the_designation_when_it_was_never_written(monkeypatch, tmp_path):
    """The live-bundle case: no `default_endpoint_id` saved, ONE enabled keyed endpoint —
    the reset now writes the designation explicitly so nothing downstream has to guess."""
    mod, db = _load_helper(monkeypatch, tmp_path)
    setp = tmp_path / "settings.json"
    _seed_reset_store(
        str(db), str(setp),
        endpoints=[("ep-or", "OpenRouter", "https://openrouter.ai/api/v1",
                    "enc:CIPHER", "llm", 1, None)],
        settings={"image_gen_enabled": True})
    mod.reset_frontend_store()
    kept = json.loads(setp.read_text())
    assert kept.get("default_endpoint_id") == "ep-or"


def test_reset_drops_a_dangling_designation_and_repoints_when_unambiguous(monkeypatch, tmp_path):
    mod, db = _load_helper(monkeypatch, tmp_path)
    setp = tmp_path / "settings.json"
    _seed_reset_store(
        str(db), str(setp),
        endpoints=[("ep-real", "OpenRouter", "https://openrouter.ai/api/v1",
                    "enc:CIPHER", "llm", 1, None)],
        settings={"default_endpoint_id": "ep-gone"})
    mod.reset_frontend_store()
    kept = json.loads(setp.read_text())
    assert kept.get("default_endpoint_id") == "ep-real", \
        "a dangling designation must re-point at the sole surviving keyed endpoint"


def test_reset_leaves_no_designation_when_ambiguous(monkeypatch, tmp_path):
    mod, db = _load_helper(monkeypatch, tmp_path)
    setp = tmp_path / "settings.json"
    _seed_reset_store(
        str(db), str(setp),
        endpoints=[("ep-a", "A", "https://a.example/v1", "enc:K1", "llm", 1, None),
                   ("ep-b", "B", "https://b.example/v1", "enc:K2", "llm", 1, None)],
        settings={})
    mod.reset_frontend_store()
    kept = json.loads(setp.read_text())
    assert "default_endpoint_id" not in kept, "two candidates — never guess a default"


def test_reset_reowns_preserved_endpoints_to_shared(monkeypatch, tmp_path):
    """Accounts are wiped by the reset, so every preserved endpoint's owner stamp is stale by
    construction — the reset re-owns the rows to NULL (shared), matching the ModelEndpoint
    'NULL = shared' semantic, so the recreated account can always resolve them."""
    mod, db = _load_helper(monkeypatch, tmp_path)
    setp = tmp_path / "settings.json"
    _seed_reset_store(
        str(db), str(setp),
        endpoints=[("ep-or", "OpenRouter", "https://openrouter.ai/api/v1",
                    "enc:CIPHER", "llm", 1, "pre-reset-ghost")],
        settings={})
    mod.reset_frontend_store()
    conn = sqlite3.connect(str(db))
    owners = [r[0] for r in conn.execute("SELECT owner FROM model_endpoints").fetchall()]
    conn.close()
    assert owners == [None], f"preserved endpoints must be re-owned to shared, got {owners}"


def test_reset_without_owner_column_still_works(monkeypatch, tmp_path):
    """Legacy stores without the owner column must keep round-tripping untouched."""
    mod, db = _load_helper(monkeypatch, tmp_path)
    setp = tmp_path / "settings.json"
    conn = sqlite3.connect(str(db))
    conn.execute("CREATE TABLE model_endpoints (id TEXT, name TEXT, base_url TEXT, "
                 "api_key TEXT, model_type TEXT, is_enabled INTEGER)")
    conn.execute("INSERT INTO model_endpoints VALUES ('ep1','P','https://p/v1','enc:K','llm',1)")
    conn.commit()
    conn.close()
    setp.write_text(json.dumps({"default_endpoint_id": "ep1"}))
    summary = mod.reset_frontend_store()
    assert summary["endpoints_preserved"] == 1
    kept = json.loads(setp.read_text())
    assert kept.get("default_endpoint_id") == "ep1"


# ═══════════════════════════════════════════════════════════════════════════════════════
# The RIGHT model, not A model — and authoring actually KICKS on the prewarm seam
# ═══════════════════════════════════════════════════════════════════════════════════════

def _capture_stream(monkeypatch):
    """Stub the one network seam (`stream_llm_with_fallback`) and capture the candidate list
    the resolved authoring fn would dispatch to."""
    llm_core = importlib.import_module("src.llm_core")
    captured = {}

    async def fake_stream(candidates, messages, **kwargs):
        captured["candidates"] = list(candidates)
        if False:  # pragma: no cover — makes this an async generator that yields nothing
            yield ""
    monkeypatch.setattr(llm_core, "stream_llm_with_fallback", fake_stream)
    return captured


def test_authoring_resolver_binds_the_configured_default_model(post_reset_settings,
                                                               rhino_is_admin, monkeypatch, run):
    """Owner ruling 2026-07-12 ('the RIGHT model, not A model'): on the owner-box store state
    the cast-authoring/genesis resolver must resolve THE configured default model identity
    (z-ai/glm-4.7 on the sole keyed endpoint) — never an arbitrary provider-list pick."""
    _seed_single_openrouter_endpoint(owner="pre-reset-ghost")
    ca = importlib.import_module("src.orwell_cast_authoring")
    captured = _capture_stream(monkeypatch)

    fn = run(ca.resolve_authoring_llm_fn("rhino"))
    assert fn is not None, "the authoring class must resolve on the owner-box store state"
    run(fn([{"role": "user", "content": "probe"}]))
    cands = captured.get("candidates") or []
    assert cands, "the resolved fn must dispatch to real candidates"
    url, model = cands[0][0], cands[0][1]
    assert model == "z-ai/glm-4.7", f"the PRIMARY candidate must be the configured default, got {model!r}"
    assert "openrouter" in url and url.endswith("/chat/completions")


def test_utility_resolver_binds_the_configured_default_model(post_reset_settings,
                                                             rhino_is_admin, monkeypatch, run):
    """The background-utility resolver (cast-identity / zeitgeist / offscreen-texture classes)
    binds a CONFIGURED identity through the utility→default chain — since 2026-07-13 that is
    the shipped utility model (the ADR 0016 qwen tier) on the default endpoint, never an
    arbitrary provider-list pick."""
    _seed_single_openrouter_endpoint(owner=None)
    ca = importlib.import_module("src.orwell_cast_authoring")
    captured = _capture_stream(monkeypatch)

    fn = run(ca._resolve_llm_fn("rhino"))
    assert fn is not None
    run(fn([{"role": "user", "content": "probe"}]))
    cands = captured.get("candidates") or []
    assert cands and cands[0][1] == "qwen/qwen3.6-27b"


def test_faithfulness_judge_resolves_the_cheap_utility_tier_not_the_narrator(
        post_reset_settings, rhino_is_admin, monkeypatch, run):
    """Owner ruling 2026-07-13 (0081 faithfulness ships ACTIVE by default): the judge resolves via
    ``_resolve_llm_fn(prefix='faithfulness', fallbacks_key='faithfulness')``, and with an UNSET
    faithfulness endpoint/model it must fall THROUGH to the CHEAP utility tier (qwen) on the default
    endpoint — NEVER the expensive narrator (glm-4.7). This keeps active-by-default faithfulness
    cheap out of the box (resolve_endpoint chains faithfulness → utility → default)."""
    _seed_single_openrouter_endpoint(owner=None)
    ca = importlib.import_module("src.orwell_cast_authoring")
    captured = _capture_stream(monkeypatch)

    fn = run(ca._resolve_llm_fn("rhino", prefix="faithfulness", fallbacks_key="faithfulness"))
    assert fn is not None, "the faithfulness judge must resolve on the owner-box store state"
    run(fn([{"role": "user", "content": "probe"}]))
    cands = captured.get("candidates") or []
    assert cands, "the resolved judge fn must dispatch to real candidates"
    assert cands[0][1] == "qwen/qwen3.6-27b", (
        "the faithfulness judge must default to the cheap utility tier (qwen), never the narrator; "
        f"got {cands[0][1]!r}")


@pytest.mark.parametrize("prefix", ["task", "faithfulness", "research"])
def test_non_utility_prefix_falls_back_to_the_configured_utility_model_not_the_narrator(
        prefix, post_reset_settings, rhino_is_admin):
    """Greptile P1 repro (2026-07-13): a NON-utility prefix (task/faithfulness/research) whose own
    endpoint is unconfigured falls back THROUGH the utility tier. With the shipped two-tier defaults
    (utility_model=qwen/qwen3.6-27b, utility_endpoint_id EMPTY so it rides the default endpoint),
    the resolved UTILITY model must be the CHEAP qwen tier — NOT the narrator (z-ai/glm-4.7). The
    prior fix covered only the `utility` prefix's own block; this pins the non-utility fallback so
    utility/background calls never silently run the expensive narrator model."""
    _seed_single_openrouter_endpoint(owner=None)
    url, model, _h = endpoint_resolver.resolve_endpoint(prefix, owner="rhino")
    assert url and url.endswith("/chat/completions")
    assert model == "qwen/qwen3.6-27b", (
        f"the {prefix!r} utility-tier fallback must resolve the configured utility model (qwen), "
        f"never the narrator; got {model!r}"
    )


def test_default_prefix_never_resolves_the_utility_model(post_reset_settings, rhino_is_admin):
    """The mirror invariant: the `default`/narrator prefix must NEVER route through the utility
    model. With default_endpoint_id empty + the single keyed endpoint, `default` still resolves the
    narrator (glm-4.7), not qwen — the fallback block's utility-model pickup skips the default
    prefix by design."""
    _seed_single_openrouter_endpoint(owner=None)
    url, model, _h = endpoint_resolver.resolve_endpoint("default", owner="rhino")
    assert url and model == "z-ai/glm-4.7", (
        f"the narrator prefix must resolve the default model, never the utility qwen tier; got {model!r}"
    )


def test_non_utility_prefix_inherits_default_model_only_when_utility_model_is_unset(
        post_reset_settings, rhino_is_admin):
    """When the configured utility_model is itself EMPTY, a non-utility fallback correctly inherits
    the default_model (the qwen tier can't win if it isn't configured)."""
    merged = post_reset_settings
    merged["utility_model"] = ""
    _seed_single_openrouter_endpoint(owner=None)
    url, model, _h = endpoint_resolver.resolve_endpoint("task", owner="rhino")
    assert url and model == "z-ai/glm-4.7", (
        f"with no utility_model, the fallback inherits default_model; got {model!r}"
    )


def test_auto_default_declines_rather_than_picking_first_available(post_reset_settings,
                                                                   rhino_is_admin):
    """If the store somehow has NO configured default_model, the auto-default must stay
    UNRESOLVED (loud) — never bind 'first model in the provider list' (the arbitrary
    openai/gpt-5.6-luna-pro narrator class)."""
    merged = post_reset_settings
    merged["default_model"] = ""
    merged["utility_model"] = ""
    from core.database import SessionLocal, ModelEndpoint
    db = SessionLocal()
    try:
        db.query(ModelEndpoint).delete()
        db.add(ModelEndpoint(
            id="ep-or", name="OpenRouter", base_url="https://openrouter.ai/api/v1",
            api_key="sk-live", is_enabled=True, model_type="llm",
            cached_models=json.dumps(["some/arbitrary-first-model", "another/model"]),
        ))
        db.commit()
    finally:
        db.close()
    url, model, _h = endpoint_resolver.resolve_endpoint("default", owner="rhino")
    assert url is None and model is None, \
        f"no configured default_model ⇒ unresolved, never first-listed; got {model!r}"


def test_run_authoring_dispatches_on_the_owner_box_state_not_a_silent_noop(
        post_reset_settings, rhino_is_admin, monkeypatch, run):
    """The historical failure was the SILENT no-op: `run_authoring` resolved no model and
    returned 0. On the owner-box store state the deep-author dispatch must actually happen."""
    _seed_single_openrouter_endpoint(owner="pre-reset-ghost")
    ca = importlib.import_module("src.orwell_cast_authoring")
    dispatched = {}

    async def fake_author_cast(cast, llm_fn, write_fn, on_authored=None, user=None, seed=None):
        dispatched["cast"] = cast
        dispatched["llm_fn"] = llm_fn
        return len(cast)
    monkeypatch.setattr(ca, "author_cast", fake_author_cast)
    gs = importlib.import_module("src.orwell_game_session")
    monkeypatch.setattr(gs, "publish_game_updated", lambda user: None)

    written = run(ca.run_authoring([{"id": "npc:1"}, {"id": "npc:2"}], "rhino"))
    assert written == 2, "authoring must DISPATCH (resolve a model), never silently no-op"
    assert dispatched.get("llm_fn") is not None


def test_prewarm_cast_kicks_deep_authoring_on_the_warm(monkeypatch, run):
    """The casting-interview prewarm entry point (`POST /api/orwell/prewarm-cast` →
    `orwell_prewarm.prewarm_cast`) must dispatch the deep-authoring kick as part of the warm —
    the earliest seam, hours before finalize."""
    pw = importlib.import_module("src.orwell_prewarm")
    pw.reset(None)
    import types

    house = [{"id": "npc:1"}, {"id": "npc:2"}]

    async def pre_seed_cast(user=None):
        return {"warmed": True, "seed": 7, "house": house,
                "portraitPrompts": [{"houseguestId": "npc:1"}, {"houseguestId": "npc:2"}]}
    engine = types.SimpleNamespace(pre_seed_cast=pre_seed_cast)

    kicked = {}

    def kickoff_authoring(cast, owner, then=None, on_authored=None, write=None, seed=None):
        kicked["cast"] = cast
        kicked["owner"] = owner
        if then:
            then()
    authoring = types.SimpleNamespace(kickoff_authoring=kickoff_authoring)

    async def run_genesis(cast, seed, user):
        return {}
    genesis = types.SimpleNamespace(run_genesis=run_genesis)

    async def run_identity(cast, user):
        return 0
    identity = types.SimpleNamespace(run_identity=run_identity)

    res = run(pw.prewarm_cast("rhino", engine=engine, authoring=authoring,
                              identity=identity, genesis=genesis))
    assert res.get("warmed") is True
    assert kicked.get("cast") == house and kicked.get("owner") == "rhino", \
        "the prewarm warm must kick deep authoring for the warmed cast"
    pw.reset(None)


def test_interview_open_kicks_the_author_warm_before_the_session_opens():
    """Owner requirement ('deep cast authoring kicks off literally first thing'): the healthy
    pre-game route() branch fires the author-warm (`_orwellWarm("prewarm-cast")`) BEFORE
    `openFreshInterviewSession()` — i.e. on app load / interview OPEN, never deferred behind
    the first production message, the photo, or finalize (#1546 ordering, pinned here)."""
    with open(os.path.join(FRONTEND, "static", "js", "orwellOnboarding.js"),
              encoding="utf-8") as f:
        js = f.read()
    # The kick and the session-open both live in route()'s healthy branch, in that order.
    kick = js.rindex('_orwellWarm("prewarm-cast")')
    open_session = js.rindex("await openFreshInterviewSession()")
    assert kick < open_session, \
        "the author-warm kick must precede the interview session open (maximum lead time)"


# NOTE (2026-07-12): the OBSERVABILITY halves of this fix — the operator-actionable
# createCharacter refusal surfacing (refusalKind + the production-note steer), the runtime
# overseer's model-wiring detection/escalation, and the /admin/status enrichment section —
# ship separately on `claude/oobe-observability` with their own gate file. This file is the
# PROD-blocker resolution gate only.

"""ADR 0010 / feature 0069 (token economy) — the admin token-economy READ surface.

Roles only — "admin"/"user"/"player" are ACCOUNT ROLES, not people; sessions are ids.
Proves the admin-gated GET /api/admin/token-economy endpoint:

  * is ADMIN-GATED — a non-admin / unauthenticated request is refused (403);
  * with a seeded ledger entry (record_turn against a tmp LEDGER_PATH, the same scheme
    as test_adr0010_vault_free_ledger.py), returns the entry's numbers + a cost total;
  * flips the soft alert true when token_spend_alert_usd is set below the game's
    accumulated cost;
  * leaks NO message-content / secret field — only the numeric/id ledger keys cross;
  * the two settings keys (reasoning_budget, token_spend_alert_usd) are present in
    DEFAULT_SETTINGS with the right default types.
"""

import importlib
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ahr = importlib.import_module("routes.admin_health_routes")
ledger = importlib.import_module("src.orwell_token_ledger")
settings_mod = importlib.import_module("src.settings")


def _app():
    app = FastAPI()
    app.include_router(ahr.setup_admin_health_routes())
    return app


# Only these scalar/id keys may ever appear in a ledger entry — the Vault-free floor.
_ALLOWED_ENTRY_KEYS = {
    "ts", "turnId", "session", "callClass",
    "inputTokens", "cachedTokens", "reasoningTokens", "outputTokens",
    # ADR 0010 follow-on #3: the applied output cap (count) + terminal stop reason (short token).
    "appliedMaxTokens", "finishReason",
    "cost", "costEstimated", "contextPercent", "provider",
}
_SENTINEL = "VAULT_SECRET_SENTINEL_must_never_cross"


@pytest.fixture
def tmp_ledger(tmp_path, monkeypatch):
    """Redirect the ledger store to a tmp file so the real data dir is never touched."""
    monkeypatch.setattr(ledger, "LEDGER_PATH", tmp_path / "orwell_token_ledger.json")
    return ledger


# ── (1) admin gating ──────────────────────────────────────────────────────────────────────

def test_endpoint_is_admin_gated(monkeypatch):
    """Auth on + no admin credential ⇒ 403, and no secret leaks on the refusal path."""
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setenv("ORWELL_ENGINE_TOKEN", "refusal-path-secret-value")
    client = TestClient(_app(), raise_server_exceptions=False)
    r = client.get("/api/admin/token-economy")
    assert r.status_code == 403
    assert "refusal-path-secret-value" not in r.text


# ── (2) a seeded entry round-trips its numbers + a cost total ───────────────────────────────

def test_seeded_entry_numbers_and_cost_total(monkeypatch, tmp_ledger):
    monkeypatch.setenv("AUTH_ENABLED", "false")  # admin bypass for the test
    tmp_ledger.record_turn(
        "player",
        session="game-1",
        turn_id="turn-1",
        call_class="narration",
        input_tokens=1200,
        cached_tokens=300,
        reasoning_tokens=80,
        output_tokens=450,
        cost=0.0123,
        context_percent=42.5,
        provider="openrouter",
    )
    client = TestClient(_app(), raise_server_exceptions=False)
    r = client.get("/api/admin/token-economy", params={"user": "player"})
    assert r.status_code == 200
    body = r.json()

    # The entry's numbers came back.
    assert len(body["entries"]) == 1
    e = body["entries"][0]
    assert e["session"] == "game-1"
    assert e["turnId"] == "turn-1"
    assert e["inputTokens"] == 1200 and e["outputTokens"] == 450
    assert e["cost"] == pytest.approx(0.0123)

    # The per-session cost total is exposed.
    assert body["sessions"]["game-1"]["costTotal"] == pytest.approx(0.0123)
    # The aggregate summary sums the token counts + cost.
    summ = body["summary"]
    assert summ["inputTokens"] == 1200 and summ["outputTokens"] == 450
    assert summ["totalCost"] == pytest.approx(0.0123)
    assert summ["latestContextPercent"] == pytest.approx(42.5)
    assert summ["turns"] == 1
    # Cost-observability: the DERIVED cache-hit rate = cachedTokens / inputTokens (300 / 1200).
    assert summ["cachedTokens"] == 300
    assert summ["cacheHitRate"] == pytest.approx(0.25)


def test_cache_hit_rate_is_none_with_zero_input(monkeypatch, tmp_ledger):
    """The divide-by-zero guard: no input tokens ⇒ cacheHitRate is None (not a fake 0.0)."""
    monkeypatch.setenv("AUTH_ENABLED", "false")
    tmp_ledger.record_turn(
        "player", session="game-1", turn_id="t0", call_class="narration",
        input_tokens=0, cached_tokens=0, output_tokens=0, cost=0.0,
    )
    client = TestClient(_app(), raise_server_exceptions=False)
    r = client.get("/api/admin/token-economy", params={"user": "player"})
    assert r.status_code == 200
    summ = r.json()["summary"]
    assert summ["inputTokens"] == 0
    assert summ["cacheHitRate"] is None


# ── (3) the soft alert flips true below the accumulated cost ─────────────────────────────────

def test_soft_alert_flips_when_threshold_below_accumulated_cost(monkeypatch, tmp_ledger):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    tmp_ledger.record_turn("player", session="game-1", turn_id="t1", cost=0.30)
    tmp_ledger.record_turn("player", session="game-1", turn_id="t2", cost=0.30)  # total 0.60

    # Threshold ABOVE the total ⇒ no alert.
    monkeypatch.setattr(settings_mod, "get_setting",
                        lambda k, d=None: 1.00 if k == "token_spend_alert_usd" else d)
    client = TestClient(_app(), raise_server_exceptions=False)
    r = client.get("/api/admin/token-economy", params={"user": "player"})
    assert r.status_code == 200
    assert r.json()["softAlert"] is False

    # Threshold BELOW the total ⇒ the soft alert trips.
    monkeypatch.setattr(settings_mod, "get_setting",
                        lambda k, d=None: 0.50 if k == "token_spend_alert_usd" else d)
    r = client.get("/api/admin/token-economy", params={"user": "player"})
    body = r.json()
    assert body["spendAlertThresholdUsd"] == pytest.approx(0.50)
    assert body["softAlert"] is True
    assert body["sessions"]["game-1"]["softAlert"] is True


# ── (4) Vault-free shape: no message-content / secret field ever crosses ─────────────────────

def test_response_carries_no_content_or_secret_field(monkeypatch, tmp_ledger):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    # Even a pathological caller that shoves a body into every text-ish field stores only a
    # clipped id; numeric fields reject text entirely. Nothing content-shaped can come back.
    tmp_ledger.record_turn(
        "player",
        session=_SENTINEL,
        turn_id=_SENTINEL,
        call_class=_SENTINEL,
        provider=_SENTINEL,
        input_tokens=_SENTINEL,
        cost=_SENTINEL,
    )
    client = TestClient(_app(), raise_server_exceptions=False)
    r = client.get("/api/admin/token-economy", params={"user": "player"})
    assert r.status_code == 200
    body = r.json()

    # Every returned entry holds ONLY the allowed scalar/id keys — no content/body field.
    for e in body["entries"]:
        assert set(e.keys()) <= _ALLOWED_ENTRY_KEYS
        for forbidden in ("content", "message", "messages", "transcript", "body",
                          "prompt", "response", "narration", "soul"):
            assert forbidden not in e
    # The numeric fields rejected the smuggled string; the sentinel never persisted as a number.
    assert body["entries"][0]["inputTokens"] == 0
    assert body["entries"][0]["cost"] == 0.0


# ── (5) the settings keys exist with the right default types ─────────────────────────────────

def test_settings_keys_present_with_correct_defaults():
    defaults = settings_mod.DEFAULT_SETTINGS
    assert "reasoning_budget" in defaults
    assert isinstance(defaults["reasoning_budget"], dict)
    # Populated with the owner-ratified optimized efforts (so the admin UI shows them).
    assert defaults["reasoning_budget"] == {
        # narration "off" (owner ruling 2026-07-13, perf audit F-PY-1): "low"/"medium" are INERT on
        # OpenRouter (llm_core drops effort, sends the computed sub-budget) so the model still bursts
        # ~4096 pre-token reasoning ("it hangs then streams"); only "off" (reasoning:{enabled:false})
        # stops it. Supersedes the ADR-0016 "low" seed.
        "narration": "off", "utility-extraction": "off",
        # #1007: background-authoring is "off" too — structured JSON extraction, not a reasoning task.
        # An enabled reasoning channel burned the cap before any visible JSON on deepseek-v4-pro (0/15).
        # casting "off" (2026-07-14): the 2026-06-21 "medium" ruling assumed reasoning-effort shaped
        # output, but on GLM-4.7 the effort knob is inert — "medium" only front-loaded the burst that
        # HANGS the casting turn (prod + golden-record). createCharacter is force-called, so off is
        # tool-safe. Same "it hangs then streams" root cause as narration.
        "casting": "off", "background-authoring": "off",
    }
    assert "token_spend_alert_usd" in defaults
    assert isinstance(defaults["token_spend_alert_usd"], float)
    assert defaults["token_spend_alert_usd"] == 0.0  # 0 ⇒ alert off

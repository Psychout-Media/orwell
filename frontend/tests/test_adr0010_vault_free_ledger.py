"""Feature 0069 / ADR 0010 (token economy) — the per-turn token/cost ledger (module slice).

Covers the standalone store only (the integration hooks from the agent loop are a later,
sequenced step). Name-agnostic — roles only (player, a second player; tool/call-class NAMES).
The store path is redirected to a tmp file so the real data dir is never touched.
"""

import importlib

import pytest

ledger = importlib.import_module("src.orwell_token_ledger")

# The exact field set an entry may hold — nothing outside this is ever persisted.
# (ADR 0010 follow-on #3 added appliedMaxTokens (a count) + finishReason (a short known token).)
_ALLOWED_KEYS = {
    "ts", "turnId", "session", "callClass",
    "inputTokens", "cachedTokens", "reasoningTokens", "outputTokens",
    "appliedMaxTokens", "finishReason",
    "cost", "costEstimated", "contextPercent", "provider",
}


@pytest.fixture(autouse=True)
def _tmp_store(tmp_path, monkeypatch):
    monkeypatch.setattr(ledger, "LEDGER_PATH", tmp_path / "orwell_token_ledger.json")


# ── (1) record → get_recent round-trip + cross-user isolation ────────────────────────────────


def test_record_then_get_recent_returns_numeric_fields():
    ledger.record_turn(
        "player",
        session="sess-1",
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
    rows = ledger.get_recent("player")
    assert len(rows) == 1
    e = rows[0]
    assert e["session"] == "sess-1"
    assert e["turnId"] == "turn-1"
    assert e["callClass"] == "narration"
    assert e["inputTokens"] == 1200
    assert e["cachedTokens"] == 300
    assert e["reasoningTokens"] == 80
    assert e["outputTokens"] == 450
    assert e["cost"] == pytest.approx(0.0123)
    assert e["contextPercent"] == pytest.approx(42.5)
    assert e["provider"] == "openrouter"
    assert isinstance(e["ts"], int)


def test_cross_user_isolation():
    ledger.record_turn("player-a", session="sa", turn_id="ta", cost=1.0)
    ledger.record_turn("player-b", session="sb", turn_id="tb", cost=2.0)
    a = ledger.get_recent("player-a")
    b = ledger.get_recent("player-b")
    assert [r["turnId"] for r in a] == ["ta"]
    assert [r["turnId"] for r in b] == ["tb"]
    # one user's read NEVER returns the other's entries
    assert all(r["session"] == "sa" for r in a)
    assert all(r["session"] == "sb" for r in b)
    # a user who never recorded sees nothing
    assert ledger.get_recent("player-c") == []


def test_defaults_record_a_zeroed_entry():
    ledger.record_turn("player", session="s", turn_id="t")
    e = ledger.get_recent("player")[0]
    assert e["callClass"] == "" and e["provider"] == ""
    assert e["inputTokens"] == e["cachedTokens"] == e["reasoningTokens"] == e["outputTokens"] == 0
    assert e["cost"] == 0.0 and e["contextPercent"] == 0.0


# ── (2) Vault-free shape: only the allowed scalar/id fields are ever stored ───────────────────

_SENTINEL = "VAULT_SECRET_SENTINEL_must_never_persist"


def test_stored_entry_keys_are_subset_of_allowed_set():
    """The stored shape contains ONLY the allowed fields — the Vault-free guarantee is
    structural. The function signature only accepts the documented kwargs, so a payload
    kwarg cannot even reach the store; we additionally assert no stored value equals a
    content-looking string we never passed."""
    ledger.record_turn(
        "player",
        session="sess-1",
        turn_id="turn-1",
        call_class="narration",
        input_tokens=10,
        output_tokens=5,
        cost=0.01,
    )
    e = ledger.get_recent("player")[0]
    # keys are a SUBSET of the allowed set — nothing extra leaked in
    assert set(e.keys()) <= _ALLOWED_KEYS
    # no stored value is a content-looking body (we never passed one)
    for v in e.values():
        assert v != _SENTINEL


def test_record_clips_ids_and_never_stores_a_body():
    """Even when a caller shoves a body/secret into every text-ish field, only a clipped
    short token (ids/class/provider) or a number (counts/cost) is stored."""
    big = f"{_SENTINEL} {('blah ' * 200)}"
    ledger.record_turn(
        "player",
        session=big,
        turn_id=big,
        call_class=big,
        provider=big,
        finish_reason=big,  # a short known token (e.g. "length") — must clip, never hold a body
        # a string secret shoved into a numeric field coerces to 0 / 0.0 — never text
        input_tokens=_SENTINEL,
        applied_max_tokens=_SENTINEL,
        cost=_SENTINEL,
        context_percent=_SENTINEL,
    )
    e = ledger.get_recent("player")[0]
    assert set(e.keys()) <= _ALLOWED_KEYS
    # ids / class / provider / finishReason are clipped to short tokens — no field holds a paragraph body
    for f in ("session", "turnId", "callClass", "provider", "finishReason"):
        assert len(e[f]) <= ledger._MAX_ID_LEN
    # the numeric fields rejected the smuggled string entirely
    assert e["inputTokens"] == 0 and e["appliedMaxTokens"] == 0
    assert e["cost"] == 0.0 and e["contextPercent"] == 0.0


# ── (3) cost totals & the soft alert ──────────────────────────────────────────────────────────


def test_game_cost_total_sums_cost_for_a_session():
    ledger.record_turn("player", session="game-1", turn_id="t1", cost=0.10)
    ledger.record_turn("player", session="game-1", turn_id="t2", cost=0.25)
    ledger.record_turn("player", session="game-1", turn_id="t3", cost=0.15)
    # a different session must not contribute
    ledger.record_turn("player", session="game-2", turn_id="t4", cost=9.99)
    assert ledger.game_cost_total("player", "game-1") == pytest.approx(0.50)
    assert ledger.game_cost_total("player", "game-2") == pytest.approx(9.99)
    # unknown session / unknown user ⇒ 0.0
    assert ledger.game_cost_total("player", "no-such") == 0.0
    assert ledger.game_cost_total("nobody", "game-1") == 0.0


def test_check_soft_alert_threshold_semantics():
    ledger.record_turn("player", session="game-1", turn_id="t1", cost=0.30)
    ledger.record_turn("player", session="game-1", turn_id="t2", cost=0.30)  # total 0.60
    assert ledger.check_soft_alert("player", "game-1", 0.50) is True   # above
    assert ledger.check_soft_alert("player", "game-1", 0.60) is False  # at (not strictly over)
    assert ledger.check_soft_alert("player", "game-1", 1.00) is False  # below total
    # threshold <= 0 ⇒ no alert
    assert ledger.check_soft_alert("player", "game-1", 0) is False
    assert ledger.check_soft_alert("player", "game-1", -5) is False
    # isolation: another user's total never triggers this user's alert
    assert ledger.check_soft_alert("other", "game-1", 0.01) is False


# ── (4) coercion of non-finite cost & negative ints ───────────────────────────────────────────


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_non_finite_cost_coerces_to_zero(bad):
    ledger.record_turn("player", session="s", turn_id="t", cost=bad, context_percent=bad)
    e = ledger.get_recent("player")[0]
    assert e["cost"] == 0.0
    assert e["contextPercent"] == 0.0
    assert ledger.game_cost_total("player", "s") == 0.0


def test_negative_ints_coerce_to_zero():
    ledger.record_turn(
        "player", session="s", turn_id="t",
        input_tokens=-10, cached_tokens=-1, reasoning_tokens=-99, output_tokens=-5,
    )
    e = ledger.get_recent("player")[0]
    assert e["inputTokens"] == e["cachedTokens"] == e["reasoningTokens"] == e["outputTokens"] == 0


def test_negative_cost_coerces_to_zero():
    ledger.record_turn("player", session="s", turn_id="t", cost=-1.5)
    assert ledger.get_recent("player")[0]["cost"] == 0.0


# ── (5) bounded retention: drop oldest beyond the cap ─────────────────────────────────────────


def test_ring_bounds_at_max_per_user(monkeypatch):
    monkeypatch.setattr(ledger, "_MAX_PER_USER", 5)
    for i in range(12):
        ledger.record_turn("player", session="s", turn_id=f"turn-{i}")
    rows = ledger.get_recent("player", limit=1000)
    assert len(rows) == 5  # capped
    # the oldest seven were dropped; only the newest five (turn-7 .. turn-11) survive, in order
    assert [r["turnId"] for r in rows] == [f"turn-{i}" for i in range(7, 12)]


# ── housekeeping: clear is per-user scoped ────────────────────────────────────────────────────


def test_clear_is_per_user_scoped():
    ledger.record_turn("player-a", session="sa", turn_id="ta")
    ledger.record_turn("player-b", session="sb", turn_id="tb")
    ledger.clear("player-a")
    assert ledger.get_recent("player-a") == []
    assert [r["turnId"] for r in ledger.get_recent("player-b")] == ["tb"]  # untouched

"""Feature 0065 (Part D) — the per-turn LLM↔engine sync/divergence ledger (module slice).

Covers the standalone store only (the integration hooks from agent_loop / chat_helpers are a
later, sequenced step). Name-agnostic — roles only (player, houseguests by id, tool NAMES).
The store path is redirected to a tmp file so the real data dir is never touched.
"""

import importlib

import pytest

ledger = importlib.import_module("src.orwell_sync_ledger")


@pytest.fixture(autouse=True)
def _tmp_store(tmp_path, monkeypatch):
    monkeypatch.setattr(ledger, "LEDGER_PATH", tmp_path / "orwell_sync_ledger.json")


# ── serialization: the expected closed-set fields ────────────────────────────────────────────


def test_recorded_entry_serializes_expected_fields():
    ledger.record_turn(
        "player",
        session="sess-1",
        turn_id="turn-1",
        beat_seq_before=4,
        beat_seq_after=5,
        tools_called=["advanceGame", "recordInteraction"],
        nudges_fired=1,
        auto_backfills=2,
        desync_detected=True,
        stale_rejections=1,
        idempotency_hits=3,
    )
    rows = ledger.get_recent("player")
    assert len(rows) == 1
    e = rows[0]
    assert e["session"] == "sess-1"
    assert e["turnId"] == "turn-1"
    assert e["beatSeqBefore"] == 4 and e["beatSeqAfter"] == 5
    assert e["toolsCalled"] == ["advanceGame", "recordInteraction"]
    assert e["nudgesFired"] == 1 and e["autoBackfills"] == 2
    assert e["desyncDetected"] is True
    assert e["staleRejections"] == 1 and e["idempotencyHits"] == 3
    assert isinstance(e["ts"], int)


def test_defaults_record_a_zeroed_entry():
    ledger.record_turn("player", session="s", turn_id="t")
    e = ledger.get_recent("player")[0]
    assert e["beatSeqBefore"] == 0 and e["beatSeqAfter"] == 0
    assert e["toolsCalled"] == []
    assert e["desyncDetected"] is False
    assert e["nudgesFired"] == e["autoBackfills"] == e["staleRejections"] == e["idempotencyHits"] == 0


# ── bounded retention: drop oldest beyond the cap ────────────────────────────────────────────


def test_bounded_retention_drops_oldest(monkeypatch):
    monkeypatch.setattr(ledger, "_MAX_PER_USER", 5)
    for i in range(12):
        ledger.record_turn("player", session="s", turn_id=f"turn-{i}")
    rows = ledger.get_recent("player", limit=1000)
    assert len(rows) == 5  # capped
    # the oldest seven were dropped; only the newest five (turn-7 .. turn-11) survive, in order
    assert [r["turnId"] for r in rows] == [f"turn-{i}" for i in range(7, 12)]


def test_get_recent_respects_limit():
    for i in range(10):
        ledger.record_turn("player", session="s", turn_id=f"turn-{i}")
    rows = ledger.get_recent("player", limit=3)
    assert [r["turnId"] for r in rows] == ["turn-7", "turn-8", "turn-9"]  # newest, in order
    assert ledger.get_recent("player", limit=0) == []


# ── Vault-sentinel: no body / secret can ever be stored ──────────────────────────────────────

_SENTINEL = "VAULT_SECRET_SENTINEL_must_never_persist"


def test_record_never_stores_a_message_body_or_secret():
    """Even when a caller tries to smuggle a body/secret into every field, only the allowed
    scalar/id/name shape is stored — the Vault-free guarantee is structural, not by convention."""
    ledger.record_turn(
        "player",
        # ids: a body shoved into the id field is CLIPPED to a short token, never the body
        session=f"sess {_SENTINEL} and a long narration paragraph " * 20,
        turn_id=f"turn {_SENTINEL}",
        # counts: a string secret coerces to 0, it can never carry text through
        beat_seq_before=_SENTINEL,
        beat_seq_after=_SENTINEL,
        nudges_fired=_SENTINEL,
        auto_backfills=_SENTINEL,
        stale_rejections=_SENTINEL,
        idempotency_hits=_SENTINEL,
        desync_detected=_SENTINEL,  # truthy ⇒ True, no text retained
        # name list: tool names are clipped tokens, never a body
        tools_called=[f"{_SENTINEL} {('blah ' * 50)}", "recordInteraction"],
    )
    e = ledger.get_recent("player")[0]

    # the stored shape contains ONLY the allowed fields — nothing extra leaked in
    # (beltsFired is the gap-#3 belt-fire counter map: names + small ints only; forcedChoice is
    # its T0-4 sibling — {tool: {"honored", "ignored"}} counts only, same coercion floor)
    assert set(e.keys()) == {
        "ts", "turnId", "session", "beatSeqBefore", "beatSeqAfter",
        "toolsCalled", "nudgesFired", "autoBackfills", "desyncDetected",
        "staleRejections", "idempotencyHits", "beltsFired", "forcedChoice", "drivenBy",
    }
    # the count fields rejected the smuggled string entirely (coerced to 0)
    for f in ("beatSeqBefore", "beatSeqAfter", "nudgesFired", "autoBackfills",
              "staleRejections", "idempotencyHits"):
        assert e[f] == 0
    # ids and names are clipped to short tokens — no field holds a paragraph-length body
    assert len(e["session"]) <= ledger._MAX_NAME_LEN
    assert len(e["turnId"]) <= ledger._MAX_NAME_LEN
    for name in e["toolsCalled"]:
        assert len(name) <= ledger._MAX_NAME_LEN
    assert e["desyncDetected"] is True


def test_no_field_holds_a_long_freeform_blob():
    """Belt-and-suspenders: the full serialized entry holds no long free-form string field."""
    big = "x" * 5000
    ledger.record_turn("player", session=big, turn_id=big, tools_called=[big])
    e = ledger.get_recent("player")[0]
    for v in (e["session"], e["turnId"], *e["toolsCalled"]):
        assert len(v) <= ledger._MAX_NAME_LEN


# ── cross-user isolation ─────────────────────────────────────────────────────────────────────


def test_cross_user_isolation():
    ledger.record_turn("player-a", session="sa", turn_id="ta")
    ledger.record_turn("player-b", session="sb", turn_id="tb")
    a = ledger.get_recent("player-a")
    b = ledger.get_recent("player-b")
    assert [r["turnId"] for r in a] == ["ta"]
    assert [r["turnId"] for r in b] == ["tb"]
    # one user's read NEVER returns the other's entries
    assert all(r["session"] == "sa" for r in a)
    assert all(r["session"] == "sb" for r in b)
    # a user who never recorded sees nothing
    assert ledger.get_recent("player-c") == []


def test_clear_is_per_user_scoped():
    ledger.record_turn("player-a", session="sa", turn_id="ta")
    ledger.record_turn("player-b", session="sb", turn_id="tb")
    ledger.clear("player-a")
    assert ledger.get_recent("player-a") == []
    assert [r["turnId"] for r in ledger.get_recent("player-b")] == ["tb"]  # untouched


def test_missing_user_maps_to_default_bucket():
    ledger.record_turn(None, session="s", turn_id="t")
    assert [r["turnId"] for r in ledger.get_recent("default")] == ["t"]
    assert [r["turnId"] for r in ledger.get_recent(None)] == ["t"]


# ── robustness ─────────────────────────────────────────────────────────────────────────────


def test_corrupt_store_never_breaks_and_get_returns_empty(tmp_path, monkeypatch):
    p = tmp_path / "ledger.json"
    p.write_text("{ not json", encoding="utf-8")
    monkeypatch.setattr(ledger, "LEDGER_PATH", p)
    assert ledger.get_recent("player") == []
    # a record over a corrupt store recovers (treats it as empty, then writes clean)
    ledger.record_turn("player", session="s", turn_id="t")
    assert [r["turnId"] for r in ledger.get_recent("player")] == ["t"]


def test_one_structured_log_line_per_turn(caplog):
    import logging
    with caplog.at_level(logging.INFO, logger="src.orwell_sync_ledger"):
        ledger.record_turn("player", session="s", turn_id="t",
                           tools_called=["advanceGame"], nudges_fired=1)
    lines = [r.getMessage() for r in caplog.records if "sync-ledger turn" in r.getMessage()]
    assert len(lines) == 1
    assert "[orwell]" in lines[0]
    assert "advanceGame" in lines[0]

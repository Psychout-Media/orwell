"""ORW-1063: an engine refusal of a decision (kind mismatch, garbled answer, unconfirmed leave, nothing open) is counted in the
sync ledger's belt counters by reason, and re-raised so the relay surfaces it. Roles only; synthetic values."""
import asyncio
import importlib

import pytest

ledger = importlib.import_module("src.orwell_sync_ledger")
oe = importlib.import_module("src.orwell_engine")


@pytest.fixture(autouse=True)
def _clean(tmp_path, monkeypatch):
    monkeypatch.setattr(ledger, "LEDGER_PATH", tmp_path / "ledger.json")
    ledger._PENDING_BELTS.clear()
    ledger._PARKED_BELTS.clear()
    yield
    ledger._PENDING_BELTS.clear()
    ledger._PARKED_BELTS.clear()


def _refuse_with(msg, monkeypatch):
    async def fake_call(tool, payload, user=None):
        raise oe.EngineToolError(msg)
    monkeypatch.setattr(oe, "_call", fake_call)


def test_a_refused_decision_is_counted_by_reason_and_reraised(monkeypatch):
    _refuse_with("decision refused (kind-mismatch): the open decision is a veto-decision", monkeypatch)
    with pytest.raises(oe.EngineToolError):
        asyncio.run(oe.submit_decision({"kind": "eviction-vote", "vote": "x"}, user="u1063"))
    assert ledger.get_belt_totals("u1063").get("decision-refused-kind-mismatch") == 1


def test_another_engine_error_is_not_counted_as_a_refusal(monkeypatch):
    _refuse_with("engine said something else", monkeypatch)
    with pytest.raises(oe.EngineToolError):
        asyncio.run(oe.submit_decision({"kind": "eviction-vote", "vote": "x"}, user="u1063"))
    assert not any(k.startswith("decision-refused") for k in ledger.get_belt_totals("u1063"))

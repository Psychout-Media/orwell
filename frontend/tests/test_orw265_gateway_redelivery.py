"""ORW-265 — a redelivered platform update must not narrate or fold twice (feature 0072).

Telegram redelivers an update (same ``update_id``) when the webhook is slow or non-2xx. The turn
path narrates AND folds a hidden-layer consequence (mandate #4), and the scene fold mints a fresh
idempotency key per call, so without an inbound dedupe a redelivery double-narrates and
double-folds. Pins: same update_id twice => one turn / one fold; a different update_id still runs;
a failed first attempt releases the claim so the platform's retry is processed. Roles only.
"""
import importlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

gateway_routes = importlib.import_module("routes.gateway_routes")
from gateway import turn_limits  # noqa: E402


@pytest.fixture
def harness(monkeypatch):
    monkeypatch.delenv("ORWELL_GATEWAY_WEBHOOK_SECRET", raising=False)
    monkeypatch.delenv("TELEGRAM_WEBHOOK_SECRET", raising=False)
    turn_limits.reset_for_tests()
    gateway_routes.reset_inbound_dedupe_for_tests()
    app = FastAPI()
    app.include_router(gateway_routes.setup_gateway_routes())
    turns, sent = [], []
    state = {"fail": False}

    async def fake_turn(platform_id, platform_identity, message_text, **kw):
        turns.append(message_text)
        if state["fail"]:
            raise RuntimeError("engine blip")
        return "narration"

    async def fake_send(self, identity, text):
        sent.append(text)

    monkeypatch.setattr(gateway_routes, "handle_platform_turn", fake_turn)
    from gateway.platforms.telegram import TelegramAdapter
    monkeypatch.setattr(TelegramAdapter, "send", fake_send)
    return TestClient(app, raise_server_exceptions=False), turns, sent, state


def _update(uid, text="hello"):
    return {"update_id": uid, "message": {"chat": {"id": 7}, "text": text}}


def test_redelivered_update_runs_one_turn(harness):
    client, turns, sent, _ = harness
    assert client.post("/gateway/webhook/telegram", json=_update(100)).status_code == 200
    r = client.post("/gateway/webhook/telegram", json=_update(100))
    assert r.status_code == 200  # ack so the platform stops retrying
    assert turns == ["hello"]
    assert sent == ["narration"]


def test_distinct_updates_each_run(harness):
    client, turns, _, _ = harness
    client.post("/gateway/webhook/telegram", json=_update(100))
    client.post("/gateway/webhook/telegram", json=_update(101))
    assert len(turns) == 2


def test_failed_first_attempt_does_not_block_the_retry(harness):
    client, turns, _, state = harness
    state["fail"] = True
    assert client.post("/gateway/webhook/telegram", json=_update(200)).status_code == 500
    state["fail"] = False
    assert client.post("/gateway/webhook/telegram", json=_update(200)).status_code == 200
    assert len(turns) == 2


def test_payload_without_update_id_is_never_deduped(harness):
    client, turns, _, _ = harness
    body = {"message": {"chat": {"id": 7}, "text": "hi"}}
    client.post("/gateway/webhook/telegram", json=body)
    client.post("/gateway/webhook/telegram", json=body)
    assert len(turns) == 2

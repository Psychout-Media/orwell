"""M1-2 (audit A2, 2026-07-07) — the in-game clock engages for a game created AFTER FE boot.

The bug: the boot apply legitimately fails pre-game ("no active game"), and the deferred
per-turn apply's `not user` guard skipped anonymous single-tenant play (AUTH_ENABLED=false ⇒
user is None) FOREVER — so every first-install season ran with the ADR-0006 clock dark (no
timeOfDay, no Nightfall gadget, no rest cue). Three seams under test:

  1. the lazy framed-turn apply fires for the anonymous single-tenant user (user=None);
  2. an engine refusal leaves it unlatched (retries next turn) — the multiuser semantics;
  3. the /api/orwell/new-game debug/ops door applies the clock on season start (it may
     start a season with no framed chat turn at all).

Name-agnostic; the engine is monkeypatched throughout (no running engine needed).
"""

import asyncio
import importlib

from fastapi import FastAPI
from fastapi.testclient import TestClient

chat_helpers = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")
orwell_routes = importlib.import_module("routes.orwell_routes")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _reset_latch(monkeypatch):
    monkeypatch.setattr(chat_helpers, "_TIME_OF_DAY_APPLIED", False)


def test_lazy_apply_fires_for_anonymous_single_tenant(monkeypatch):
    """user=None (AUTH off) must APPLY, not skip — the anon→default sandbox mapping."""
    _reset_latch(monkeypatch)
    calls = []

    async def fake_set(enabled, user=None):
        calls.append((bool(enabled), user))
        return {"ok": True}

    monkeypatch.setattr(orwell_engine, "set_time_of_day", fake_set)
    # the helper imports get_setting function-locally from src.settings — patch THERE
    settings_mod = importlib.import_module("src.settings")
    monkeypatch.setattr(settings_mod, "get_setting", lambda key, default=None: True)
    _run(chat_helpers._apply_persisted_time_of_day_once(None))
    assert calls == [(True, None)], "the anonymous single-tenant apply must reach the engine"
    assert chat_helpers._TIME_OF_DAY_APPLIED is True, "success latches once-per-process"
    _run(chat_helpers._apply_persisted_time_of_day_once(None))
    assert len(calls) == 1, "latched — never re-applied on later turns"


def test_engine_refusal_stays_unlatched_and_retries(monkeypatch):
    """A refusal (e.g. multiuser rejecting a userless call) must NOT latch — the next
    framed turn (with a real user) retries. Fail-soft: never raises into the turn."""
    _reset_latch(monkeypatch)
    attempts = []

    async def refuse_then_accept(enabled, user=None):
        attempts.append(user)
        if len(attempts) == 1:
            raise RuntimeError("engine refused: no user routed")
        return {"ok": True}

    monkeypatch.setattr(orwell_engine, "set_time_of_day", refuse_then_accept)
    _run(chat_helpers._apply_persisted_time_of_day_once(None))
    assert chat_helpers._TIME_OF_DAY_APPLIED is False, "a refusal must not latch"
    _run(chat_helpers._apply_persisted_time_of_day_once("someone"))
    assert chat_helpers._TIME_OF_DAY_APPLIED is True
    assert attempts == [None, "someone"]


def test_new_game_route_applies_the_clock(monkeypatch):
    """The debug/ops season-start door applies the persisted clock — it can mint a season
    with no framed chat turn, so it cannot rely on the lazy per-turn seam."""
    _reset_latch(monkeypatch)
    monkeypatch.setenv("AUTH_ENABLED", "false")
    applied = []

    async def fake_state(user=None, timeout=None):
        return {"started": False}

    async def fake_create(name, **kwargs):
        return {"started": True}

    async def fake_set(enabled, user=None):
        applied.append(bool(enabled))
        return {"ok": True}

    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    monkeypatch.setattr(orwell_engine, "create_character", fake_create)
    monkeypatch.setattr(orwell_engine, "set_time_of_day", fake_set)

    app = FastAPI()
    app.include_router(orwell_routes.setup_orwell_routes())
    client = TestClient(app)
    r = client.post("/api/orwell/new-game", json={"playerName": "P", "confirm": True})
    assert r.status_code == 200 and r.json().get("started") is True
    assert applied == [True], "season start must push the persisted clock onto the engine"


def test_boot_apply_demotes_the_expected_pregame_miss():
    """Source gate: the boot apply's catch distinguishes the EXPECTED pre-game refusal
    ('no active game' → info, deferred) from a real failure (→ warning). The old
    unconditional warning was the A2 red herring that hid the real bug."""
    import os
    src = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "app.py"), encoding="utf-8").read()
    assert "no active game" in src and "Time-of-day boot apply deferred" in src, \
        "app.py's boot apply must demote the expected pre-game miss to info"


def test_latch_expires_so_a_restarted_engine_is_re_told(monkeypatch):
    """Batch D: the engine flag lives on the ENGINE; an engine-only restart boots it at the env default.
    The FE latch must EXPIRE so the persisted setting is re-pushed within minutes — not never."""
    _reset_latch(monkeypatch)
    calls = []

    async def fake_set(enabled, user=None):
        calls.append(bool(enabled))
        return {"ok": True}

    monkeypatch.setattr(orwell_engine, "set_time_of_day", fake_set)
    settings_mod = importlib.import_module("src.settings")
    monkeypatch.setattr(settings_mod, "get_setting", lambda key, default=None: True)
    _run(chat_helpers._apply_persisted_time_of_day_once(None))
    _run(chat_helpers._apply_persisted_time_of_day_once(None))
    assert len(calls) == 1, "within the window it stays latched"
    # the window elapses (e.g. the engine was bounced meanwhile) → the next turn re-pushes
    monkeypatch.setattr(chat_helpers, "_TIME_OF_DAY_APPLIED_AT",
                        chat_helpers._TIME_OF_DAY_APPLIED_AT - chat_helpers._TIME_OF_DAY_REVERIFY_SECS - 1)
    _run(chat_helpers._apply_persisted_time_of_day_once(None))
    assert len(calls) == 2, "an expired latch re-applies the clock setting"


def test_deploy_boots_the_engine_clock_on():
    """A restarted engine must come up with the clock ON (the FE default) before any FE re-push."""
    from pathlib import Path
    src = (Path(__file__).resolve().parents[2] / "deploy" / "orwell-env-defaults.sh").read_text(encoding="utf-8")
    assert "\nORWELL_TIME_OF_DAY=1\n" in src

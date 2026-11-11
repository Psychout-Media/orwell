"""ORW-97 / A65: the engine HOLDS an ordinary advanceGame before the schedule says an event is due (typed `held`, reason "schedule", nothing committed).
The FE must read it: tell the narrator why from the Vault-free payload, never treat it as a successful advance (no refresh/pending cache), and mark the hold
so the stall-nudge / forced-advance belts do not escalate against the refusal. A real advance clears the hold."""
import asyncio
import importlib
import json

chat_helpers = importlib.import_module("routes.chat_helpers")
HELD = {"beatSeq": 5, "event": None, "pending": None, "held": {"next": "hoh-competition", "minutesUntil": 180, "reason": "schedule"}}


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _advance(monkeypatch, res, owner):
    from src import tool_implementations as ti
    from src import orwell_engine
    seen = {"calls": 0, "pending": 0, "refresh": 0}

    async def fake_advance(expected_beat_seq=None, idempotency_key=None, user=None):
        seen["calls"] += 1
        return res

    async def fake_refresh(owner_, res_):
        seen["refresh"] += 1

    monkeypatch.setattr(orwell_engine, "advance_game", fake_advance)
    monkeypatch.setattr(orwell_engine, "remember_pending", lambda *a, **k: seen.__setitem__("pending", seen["pending"] + 1))
    monkeypatch.setattr(ti, "_refresh_after_model_progression", fake_refresh)
    return _run(ti.do_advance_game("{}", owner=owner)), seen


def test_schedule_held_is_explained_not_a_successful_advance(monkeypatch):
    chat_helpers.clear_engine_held("o97a")
    out, seen = _advance(monkeypatch, HELD, "o97a")
    body = json.loads(out["output"])
    assert body["held"] is True
    assert "hoh competition" in body["note"] and "3 hours" in body["note"] and "do not call advanceGame again" in body["note"]
    assert "beatSeq" not in body and "event" not in body  # the raw engine view is not handed back as if it advanced
    assert seen["refresh"] == 0 and seen["pending"] == 0 and seen["calls"] == 1  # not progress, not looped
    chat_helpers.clear_engine_held("o97a")


def test_schedule_hold_blocks_stall_escalation_until_a_real_advance(monkeypatch):
    chat_helpers.clear_engine_held("o97b")
    assert not chat_helpers.production_is_holding("o97b")
    _advance(monkeypatch, HELD, "o97b")
    assert chat_helpers.production_is_holding("o97b"), "the stall-nudge reads production_is_holding: it must not force advanceGame while the engine says held"
    _advance(monkeypatch, {"beatSeq": 6, "event": {"beat": "hoh-competition", "content": "x"}}, "o97b")
    assert not chat_helpers.production_is_holding("o97b")


def test_night_hold_without_reason_keeps_its_own_note_and_sets_no_schedule_hold(monkeypatch):
    chat_helpers.clear_engine_held("o97c")
    out, _ = _advance(monkeypatch, {"beatSeq": 5, "event": None, "held": {"next": "nominations", "minutesUntil": 300}}, "o97c")
    assert "turn in" in json.loads(out["output"])["note"]
    assert not chat_helpers.production_is_holding("o97c")


def test_held_note_is_vault_free_and_tolerates_a_bad_payload():
    assert "later today" in chat_helpers.engine_held_note({"next": "veto-ceremony", "minutesUntil": 0})
    assert "next scheduled event" in chat_helpers.engine_held_note(None)
    assert not chat_helpers.engine_held_is_schedule({"held": {"next": "x", "minutesUntil": 1}})

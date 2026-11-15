"""ORW-236 / ORW-116 (b): the engine HOLDS the night (typed `held`, nothing committed). The model-driven advanceGame turns that into a plain
narrator note - stay in the scene, do not narrate a new day or ceremony - instead of a bare typed `held`. A real beat is untouched."""
import asyncio
import importlib
import json

chat_helpers = importlib.import_module("routes.chat_helpers")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _advance(monkeypatch, res):
    from src import tool_implementations as ti
    from src import orwell_engine

    async def fake_advance(expected_beat_seq=None, idempotency_key=None, user=None):
        return res

    monkeypatch.setattr(orwell_engine, "advance_game", fake_advance)
    monkeypatch.setattr(orwell_engine, "remember_pending", lambda *a, **k: None)
    return _run(ti.do_advance_game("{}", owner="owner-236"))


def test_held_night_becomes_a_plain_note(monkeypatch):
    out = _advance(monkeypatch, {"beatSeq": 5, "event": None, "held": {"next": "nominations", "minutesUntil": 300}})
    body = json.loads(out["output"])
    assert body["held"] is True
    assert "turn in" in body["note"] and "Do not narrate a new day" in body["note"]


def test_a_real_beat_is_untouched(monkeypatch):
    out = _advance(monkeypatch, {"beatSeq": 6, "event": {"beat": "day-break", "content": "x"}})
    assert json.loads(out["output"])["event"]["beat"] == "day-break"


def test_pre_resolve_does_not_walk_a_held_night(monkeypatch):
    """The prod log 21:17:11 shape: the FE pre-resolve advances a ceremony on a spectator turn and the beat was 'The house turns in for the night, and a new day
    dawns...'. With the engine HOLDING the night, the pre-resolve must NOT mark a walked beat nor re-frame to a new day: it returns the board as it is."""
    from src import orwell_engine
    calls = {"marked": 0, "advanced": 0}

    async def fake_status(user=None, **kw):
        return {"beatSeq": 4}

    async def fake_advance(expected_beat_seq=None, idempotency_key=None, user=None):
        calls["advanced"] += 1
        return {"event": None, "held": {"next": "nominations", "minutesUntil": 300}, "beatSeq": 4}

    async def fake_state(user=None, **kw):
        return {"phase": "nominations", "week": 1, "beatSeq": 4}

    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    monkeypatch.setattr(orwell_engine, "advance_game", fake_advance)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    monkeypatch.setattr(chat_helpers, "mark_pre_resolved_advance", lambda *a, **k: calls.__setitem__("marked", calls["marked"] + 1))
    chat_helpers.clear_social_runway("u236")
    gs = {"phase": "nominations", "week": 1}
    out = _run(chat_helpers._pre_resolve_npc_ceremony("u236", gs, retry=False, player_msg="let's see the noms"))
    assert calls["advanced"] == 1, "the pre-resolve did try to advance"
    assert calls["marked"] == 0, "a held night is not a walked beat"
    assert out == gs

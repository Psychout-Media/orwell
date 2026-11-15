"""HOT FIX (prod f4ea9284, 2026-11-08, Ryne live): in a fresh premiere the arrivals stopped after the ninth houseguest; the log repeated "production holds premiere for user=... - not due yet (message 21/150)" and the narrator
said "no new arrivals". Cause: the premiere-exit hold (ORW-116 night-hold work) treated ANY premiere with `complete: true` and a live `daySchedule` as "exited and waiting for the first HOH", so the pre-resolve held the
model's advanceGame - and an arrival is released by advanceGame. Under Ryne's schedule the entrances run in the afternoon and only the exit/toast waits for the evening, so the hold must apply only once the staged
entrances and the toast are DONE. Roles only."""
import asyncio
import importlib

ch = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")


def _run(c):
    return asyncio.get_event_loop().run_until_complete(c)


def _state(stage):
    premiere = {"complete": True, "metCount": 16, "total": 16}
    if stage is not None:
        premiere["entrance"] = {"stage": stage, "index": 9, "of": 15}
    return {"phase": "premiere", "week": 1, "started": True, "beatSeq": 5, "premiere": premiere,
            "daySchedule": {"next": "hoh-competition", "phase": "afternoon", "due": False, "minutesUntil": 420}}


def _drive(monkeypatch, stage, user):
    ch.clear_social_runway(user)
    ch._PRODUCTION_HOLD.pop(ch._runway_key(user), None)
    calls = {"status": 0}

    async def fake_status(user=None, **kw):
        calls["status"] += 1
        return {"beatSeq": 5, "pending": None}

    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    st = _state(stage)
    out = _run(ch._pre_resolve_npc_ceremony(user, st, retry=False, player_msg="hello everyone"))
    return out, st, calls


def test_staged_entrances_are_never_held(monkeypatch):
    out, st, calls = _drive(monkeypatch, "entrances", "u-hf1")
    assert out is st, "the premiere with arrivals still to come is not a held event: the state passes through untouched"
    assert not ch.scheduled_event_is_held("u-hf1"), "the model's advanceGame (the arrival release) must not be told production holds it"
    assert calls["status"] == 0, "the pre-resolve must not even enter the hold path"


def test_the_toast_is_not_held_either(monkeypatch):
    out, st, calls = _drive(monkeypatch, "toast", "u-hf2")
    assert out is st and not ch.scheduled_event_is_held("u-hf2")


def test_once_entrances_and_toast_are_done_the_first_hoh_exit_is_held_as_before(monkeypatch):
    out, st, calls = _drive(monkeypatch, "done", "u-hf3")
    assert ch.scheduled_event_is_held("u-hf3"), "after the toast the not-yet-due first HOH exit is held (ORW-116)"

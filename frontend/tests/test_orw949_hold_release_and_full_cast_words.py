"""ORW-949 - an expired house-entry watch must still release the player, and the cast-time words wait for the whole cast.

Prod, 2026-11-26: the house-entry marker was set and never cleared. The long watch window expired not-ready, the marker
was re-recorded and nothing re-checked, so only a process restart released the player. Pinned here:
  - after the loud expiry the watch keeps re-checking slowly and, once the cast is ready, clears the marker, runs
    `on_ready` once and publishes game-updated (one watch per user; stops if someone else clears the marker);
  - the deferred post-start kicks of `do_create_character` run exactly once through that late path;
  - `run_words` waits (bounded, non-blocking) for `unarrivedCount` to reach 0, then authors the whole cast; a spent
    budget authors what is visible and alerts `npc-minds:partial-cast`; a state without the count does not wait.

Roles only - every string is a generic probe, never cast material.
"""
import asyncio
import importlib
import json

from conftest import _run

ca = importlib.import_module("src.orwell_cast_authoring")
ti = importlib.import_module("src.tool_implementations")
oe = importlib.import_module("src.orwell_engine")
cid = importlib.import_module("src.orwell_cast_identity")
gs = importlib.import_module("src.orwell_game_session")
w = importlib.import_module("src.orwell_npc_minds_words")


def _result(ready):
    return {"ready": ready, "authored": 15 if ready else 5, "total": 15, "missing": 0 if ready else 10}


async def _until(pred, tries=300):
    for _ in range(tries):
        if pred():
            return True
        await asyncio.sleep(0.01)
    return False


def _fake_ready(monkeypatch, ready_after):
    """await_house_ready stub: not ready for the first `ready_after` calls, then ready."""
    calls = {"n": 0}

    async def _fn(owner, **k):
        calls["n"] += 1
        return _result(calls["n"] > ready_after)
    monkeypatch.setattr(ca, "await_house_ready", _fn)
    return calls


def test_expired_watch_releases_when_the_cast_lands_late(monkeypatch):
    errors = []
    monkeypatch.setattr(ca.logger, "error", lambda msg, *a, **k: errors.append(msg % a))
    calls = _fake_ready(monkeypatch, ready_after=3)
    pushed = {"n": 0}
    monkeypatch.setattr(gs, "publish_game_updated", lambda user=None: pushed.__setitem__("n", pushed["n"] + 1))
    fired = {"n": 0}

    async def _drive():
        ca.begin_house_entry_hold("late1", {"authored": 3, "total": 15})
        assert ca.kickoff_house_ready_watch("late1", on_ready=lambda: fired.__setitem__("n", fired["n"] + 1),
                                            timeout=0.0, recheck_interval=0.01) is True
        # while it is re-checking, a second kick is still a no-op (one watch per user)
        again = ca.kickoff_house_ready_watch("late1", on_ready=lambda: fired.__setitem__("n", fired["n"] + 100))
        cleared = await _until(lambda: ca.house_entry_gate_status("late1") is None)
        await asyncio.sleep(0.05)
        return again, cleared
    again, cleared = _run(_drive())
    assert again is False
    assert cleared, "the late-landing cast must clear the hold without a restart"
    assert fired["n"] == 1 and pushed["n"] == 1
    assert sum("watch expired" in m for m in errors) == 1, "the loud expiry is logged exactly once"
    assert ca.house_ready_watch_active("late1") is False


def test_late_watch_stops_when_someone_else_clears_the_marker(monkeypatch):
    calls = _fake_ready(monkeypatch, ready_after=10 ** 6)
    fired = {"n": 0}

    async def _drive():
        ca.begin_house_entry_hold("late2", {"authored": 3, "total": 15})
        ca.kickoff_house_ready_watch("late2", on_ready=lambda: fired.__setitem__("n", fired["n"] + 1),
                                     timeout=0.0, recheck_interval=0.01)
        await _until(lambda: calls["n"] >= 3)
        ca.clear_house_entry_gate_block("late2")
        stopped = await _until(lambda: not ca.house_ready_watch_active("late2"))
        seen = calls["n"]
        await asyncio.sleep(0.05)
        return stopped, seen
    stopped, seen = _run(_drive())
    assert stopped, "the watch ends once the marker is gone"
    assert calls["n"] == seen and fired["n"] == 0


def test_deferred_post_start_kicks_run_once_through_the_late_path(monkeypatch):
    async def fake_create(*a, **k):
        house = [{"id": "player", "name": "The Player"}] + [{"id": f"npc:{i}", "name": f"Houseguest {i}"} for i in range(1, 16)]
        return {"started": True, "house": house, "portraitPrompts": []}
    monkeypatch.setattr(oe, "create_character", fake_create)
    monkeypatch.setattr(oe, "get_game_state", lambda *a, **k: _async_value({"started": False}))
    monkeypatch.setattr(cid, "kickoff_identity", lambda *a, **k: None)
    monkeypatch.delenv("ORWELL_ALLOW_FLOOR_START", raising=False)
    monkeypatch.setattr(gs, "publish_game_updated", lambda user=None: None)
    kicks = {"zeitgeist": 0, "producer": 0, "minds": 0}
    for modname, fn, key in (("orwell_zeitgeist", "kickoff_capture", "zeitgeist"),
                             ("orwell_producer_authoring", "kickoff_producer_authoring", "producer"),
                             ("orwell_npc_minds_words", "kickoff_npc_minds_words", "minds")):
        mod = importlib.import_module("src." + modname)
        monkeypatch.setattr(mod, fn, lambda owner, _k=key: kicks.__setitem__(_k, kicks[_k] + 1))

    async def _gate_on(owner):
        return True
    monkeypatch.setattr(ca, "house_entry_gate_active", _gate_on)
    state = {"ready": False}

    async def _ready(owner, **k):
        return _result(state["ready"])
    monkeypatch.setattr(ca, "await_house_ready", _ready)
    real_kick = ca.kickoff_house_ready_watch
    monkeypatch.setattr(ca, "kickoff_house_ready_watch",
                        lambda owner, on_ready=None, **k: real_kick(owner, on_ready=on_ready, timeout=0.0, recheck_interval=0.01))

    async def _drive():
        res = await ti.do_create_character('{"playerName":"P"}', owner="late3")
        assert json.loads(res["output"]).get("started") is False
        await asyncio.sleep(0.05)
        assert kicks == {"zeitgeist": 0, "producer": 0, "minds": 0}
        state["ready"] = True
        await _until(lambda: ca.house_entry_gate_status("late3") is None)
        await asyncio.sleep(0.05)
    _run(_drive())
    assert kicks == {"zeitgeist": 1, "producer": 1, "minds": 1}


async def _async_value(v):
    return v


# -- run_words waits for the whole cast ------------------------------------------------------------------------------------

def _cards(n):
    return [{"id": f"npc:{i}", "name": f"Houseguest {i}", "vocation": "role"} for i in range(1, n + 1)]


def _words_env(monkeypatch, states, alerts):
    """Wire run_words to a model that answers from a script and an engine that serves `states` in order (last one repeats)."""
    monkeypatch.setattr(w, "_alert", lambda owner, key, what: alerts.append(key))
    seen = {"reads": 0, "habit_calls": []}

    async def resolve(owner):
        async def llm(msgs):
            seen["habit_calls"].append(len(msgs))
            return json.dumps({"habits": ["gym-rat", "early-riser"], "aimHint": "win-by-comps", "aimWhy": "a former sprinter"})
        return llm

    async def state(user=None, **k):
        i = min(seen["reads"], len(states) - 1)
        seen["reads"] += 1
        return states[i]

    async def rec_traits(req, user=None):
        seen.setdefault("traits_for", []).append(req)
        return {"accepted": True}

    async def rec_culture(req, user=None):
        seen.setdefault("culture_for", []).append(req)
        return {"accepted": True}

    import src.orwell_cast_authoring as authoring
    monkeypatch.setattr(authoring, "_resolve_llm_fn", resolve)
    monkeypatch.setattr(oe, "get_game_state", state)
    monkeypatch.setattr(oe, "record_npc_traits", rec_traits)
    monkeypatch.setattr(oe, "record_house_culture", rec_culture)
    monkeypatch.setenv("ORWELL_NPC_MINDS_CAST_WAIT_S", "0.01")
    return seen


def test_words_wait_for_the_unarrived_then_author_the_whole_cast(monkeypatch):
    alerts = []
    seen = _words_env(monkeypatch, [{"house": _cards(2), "unarrivedCount": 3}, {"house": _cards(4), "unarrivedCount": 1},
                                    {"house": _cards(5), "unarrivedCount": 0}], alerts)
    monkeypatch.setenv("ORWELL_NPC_MINDS_CAST_BUDGET_S", "60")
    _run(w.run_words("words1"))
    assert seen["reads"] == 3, "it re-read the state until nobody was left unarrived"
    assert len(seen["traits_for"][0]["traits"]) == 5, "habits were authored for all five arrived cards"
    assert "npc-minds:partial-cast" not in alerts


def test_words_alert_and_author_the_visible_cast_when_the_budget_runs_out(monkeypatch):
    alerts = []
    seen = _words_env(monkeypatch, [{"house": _cards(2), "unarrivedCount": 3}], alerts)
    monkeypatch.setenv("ORWELL_NPC_MINDS_CAST_BUDGET_S", "0.05")
    _run(w.run_words("words2"))
    assert alerts.count("npc-minds:partial-cast") == 1
    assert len(seen["traits_for"][0]["traits"]) == 2, "the visible cast was still authored"


def test_words_do_not_wait_without_an_unarrived_count(monkeypatch):
    """Control: a state with no count (or 0) behaves as before - one read, no alert."""
    for st in ({"house": _cards(2)}, {"house": _cards(2), "unarrivedCount": 0}):
        alerts = []
        seen = _words_env(monkeypatch, [st], alerts)
        _run(w.run_words("words3"))
        assert seen["reads"] == 1 and "npc-minds:partial-cast" not in alerts

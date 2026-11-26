"""ORW-566 part c (spec 0183): the model's words for a new group (a name, a ritual, a signal, an inside joke).

One cheap utility call per NEW group, one retry, fail-soft (the engine floor stands), idempotent, public facts only; the prompt states rules, never a menu
or a sample (Ryne's standing rule 2026-11-17). Injected fakes; no live model. Roles only.
"""
import pytest
import asyncio
import json
import re
from pathlib import Path

from src import orwell_group_identity as g

CARD_A = {"id": "npc:1", "name": "Houseguest A", "vocation": "ER nurse", "biography": "ran marathons", "soul": {"emotionalState": 0.2},
          "hiddenElements": [{"kind": "secret-motive", "detail": "zzsecretzz"}], "trust": 0.9}
CARD_B = {"id": "npc:2", "name": "Houseguest B", "vocation": "chef", "demeanor": "deadpan"}
GROUP = {"groupId": "alliance:1", "kind": "alliance", "members": ["npc:1", "npc:2"], "room": "kitchen", "spot": "the counter",
         "culture": {"spots": [], "rituals": [], "runningJoke": "the lost spoon"}, "otherNames": ["Existing Crew"]}
GOOD = json.dumps({"name": "Counter Crew", "ritual": "a quiet check-in", "signal": "two taps", "insideJoke": "the lost spoon"})


def run(coro):
    return asyncio.run(coro)


def test_prompt_states_rules_and_carries_no_sample_or_menu_text():
    msgs = g.group_messages(GROUP, [CARD_A, CARD_B])
    system = msgs[0]["content"]
    assert re.search(r"Rules:", system)
    for banned in ("e.g.", "for example", "such as", "like:", "one of"):
        assert banned not in system.lower(), banned
    # no quoted word lists in the instruction text (quotes appear only as the JSON key names, which are not in the text at all)
    assert not re.search(r"\"[^\"]+\"\s*,\s*\"[^\"]+\"", system)
    assert "do not repeat any group name" in system.lower() and "never a generic label" in system.lower()


def test_the_call_sees_only_public_facts_of_the_members_the_room_and_the_culture():
    blob = json.dumps(g.group_messages(GROUP, [CARD_A, CARD_B]))
    assert "ER nurse" in blob and "chef" in blob and "the lost spoon" in blob and "Existing Crew" in blob and "the counter" in blob
    for hidden in ("zzsecretzz", "emotionalState", "npc:1", "npc:2", "0.9", "alliance:1"):
        assert hidden not in blob, hidden


def test_one_call_one_write_back_with_the_group_id():
    calls, written = [], []

    async def llm(msgs):
        calls.append(msgs)
        return "prose first " + GOOD + " and a trailer"

    async def write(req):
        written.append(req)
        return {"accepted": True}

    out = run(g.author_group(GROUP, [CARD_A, CARD_B], llm, write))
    assert out == {"accepted": True} and len(calls) == 1
    assert written == [{"groupId": "alliance:1", "name": "Counter Crew", "ritual": "a quiet check-in", "signal": "two taps", "insideJoke": "the lost spoon"}]


def test_a_failure_is_retried_once_then_skipped_and_nothing_is_written():
    calls = {"n": 0}

    async def flaky(msgs):
        calls["n"] += 1
        return "not json" if calls["n"] == 1 else GOOD

    async def never(msgs):
        calls["n"] += 1
        raise RuntimeError("down")

    written = []

    async def write(req):
        written.append(req)
        return {"accepted": True}

    assert run(g.author_group(GROUP, [CARD_A], flaky, write))["accepted"] is True and calls["n"] == 2
    calls["n"] = 0
    written.clear()
    assert run(g.author_group(GROUP, [CARD_A], never, write)) == {"accepted": False, "reason": "skipped"}
    assert calls["n"] == 2 and written == []


def test_a_write_failure_never_raises():
    async def llm(msgs):
        return GOOD

    async def write(req):
        raise RuntimeError("engine down")

    assert run(g.author_group(GROUP, [CARD_A], llm, write)) == {"accepted": False, "reason": "write-failed"}


def test_run_is_idempotent_a_done_group_is_not_called_again_and_empty_list_calls_no_model(monkeypatch):
    g._GAVE_UP.clear()
    alerts = []
    monkeypatch.setattr(g, "_alert", lambda owner, key, what: alerts.append(key))
    calls = {"llm": 0, "read": 0}
    waiting = [dict(GROUP)]

    async def read():
        calls["read"] += 1
        return list(waiting)

    async def state():
        return {"house": [CARD_A, CARD_B]}

    async def llm(msgs):
        calls["llm"] += 1
        return GOOD

    async def write(req):
        waiting.clear()  # the engine took the words: the group no longer waits
        return {"accepted": True}

    assert run(g.run_group_words("u", llm_fn=llm, read_fn=read, state_fn=state, write_fn=write))["groups"] == 1
    assert run(g.run_group_words("u", llm_fn=llm, read_fn=read, state_fn=state, write_fn=write)) == {"groups": 0}
    assert calls["llm"] == 1 and alerts == []


def test_no_model_leaves_the_floor_and_alerts_once(monkeypatch):
    g._GAVE_UP.clear()
    alerts = []
    monkeypatch.setattr(g, "_alert", lambda owner, key, what: alerts.append(key))

    async def read():
        return [dict(GROUP)]

    async def no_model(owner):
        return None

    import src.orwell_cast_authoring as ca
    monkeypatch.setattr(ca, "_resolve_llm_fn", no_model)
    out = run(g.run_group_words("u", read_fn=read))
    assert out["reason"] == "no-model" and alerts == ["group-identity:no-model"]


def test_a_group_that_fails_twice_alerts_and_is_not_retried_this_run(monkeypatch):
    g._GAVE_UP.clear()
    alerts = []
    monkeypatch.setattr(g, "_alert", lambda owner, key, what: alerts.append(key))
    calls = {"n": 0}

    async def read():
        return [dict(GROUP)]

    async def state():
        return {"house": [CARD_A]}

    async def bad(msgs):
        calls["n"] += 1
        return "nothing usable"

    async def write(req):
        return {"accepted": True}

    run(g.run_group_words("u", llm_fn=bad, read_fn=read, state_fn=state, write_fn=write))
    run(g.run_group_words("u", llm_fn=bad, read_fn=read, state_fn=state, write_fn=write))
    assert calls["n"] == 2 and alerts == ["group-identity:group-skipped"]


def test_kickoff_is_a_noop_with_the_engine_flag_off(monkeypatch):
    from src import orwell_engine
    monkeypatch.setattr(orwell_engine, "engine_flag", lambda name, default=False: False)
    ran = []

    async def fake_run(owner, **kw):
        ran.append(owner)
        return {}

    monkeypatch.setattr(g, "run_group_words", fake_run)

    async def go():
        g.kickoff_group_identity("u")
        await asyncio.sleep(0.01)

    run(go())
    assert ran == []


def test_kickoff_runs_once_in_background_and_releases_the_guard(monkeypatch):
    # ORW-983: this was red on main twice (ran == [] with "Event loop is closed"). Two causes, both in the TEST: the module's single-flight set is process-wide, so a key a
    # kickoff in an earlier test left in flight (its loop closed before the runner finished) made every kickoff here return at once; and the 10 ms sleeps decided whether the
    # background run had finished. Now the set is this test's own and each step waits for the run it expects (bounded), never for the clock.
    from src import orwell_engine
    monkeypatch.setattr(orwell_engine, "engine_flag", lambda name, default=False: True)
    monkeypatch.setattr(g, "_IN_FLIGHT", set())
    ran = []

    async def fake_run(owner, **kw):
        ran.append(owner)
        return {}

    monkeypatch.setattr(g, "run_group_words", fake_run)
    monkeypatch.setattr(g, "run_name_tickets", fake_run)  # part c2 rides the same single-flight run

    async def until(n):
        for _ in range(500):
            if len(ran) >= n and not g._IN_FLIGHT:
                return
            await asyncio.sleep(0.01)
        raise AssertionError(f"the background run never finished: {ran} in flight {g._IN_FLIGHT}")

    async def go():
        g.kickoff_group_identity("u")
        g.kickoff_group_identity("u")  # one run in flight
        await until(2)
        assert ran == ["u", "u"], "the second kickoff did not start a second run"
        g.kickoff_group_identity("u")  # released: a later turn can run again
        await until(4)

    run(go())
    assert ran == ["u", "u", "u", "u"]  # words + names per run


def test_the_engine_wrappers_dispatch_the_two_tools(monkeypatch):
    from src import orwell_engine as oe
    seen = []

    async def fake_call(tool, args, user=None, **kw):
        seen.append((tool, args))
        return [{"groupId": "alliance:1"}] if tool == "groupsAwaitingWords" else {"accepted": True}

    monkeypatch.setattr(oe, "_call", fake_call)
    assert run(oe.groups_awaiting_words(user="u")) == [{"groupId": "alliance:1"}]
    assert run(oe.record_group_identity({"groupId": "alliance:1", "name": "x"}, user="u")) == {"accepted": True}
    assert [t for t, _ in seen] == ["groupsAwaitingWords", "recordGroupIdentity"]


def test_the_agent_loop_kicks_the_driver_after_a_turn():
    src = (Path(__file__).resolve().parents[1] / "src" / "agent_loop.py").read_text()
    assert "kickoff_group_identity(owner)" in src and "_group_identity_after_turn()" in src


def test_a_hidden_group_is_never_described_to_any_model(monkeypatch):
    """Vault Wall ruling: the engine lists only groups the player already knows of. With nothing listed the driver makes no model call and names no id."""
    g._GAVE_UP.clear()
    calls = {"llm": 0}

    async def read():
        return []  # a hidden alliance / an unseen habit is simply not in the engine's list

    async def llm(msgs):
        calls["llm"] += 1
        return GOOD

    out = run(g.run_group_words("u", llm_fn=llm, read_fn=read))
    assert out == {"groups": 0} and calls["llm"] == 0


def test_only_the_members_the_engine_lists_reach_the_prompt(monkeypatch):
    g._GAVE_UP.clear()
    seen = []
    group = dict(GROUP, members=["npc:1"])

    async def read():
        return [group]

    async def state():
        return {"house": [CARD_A, CARD_B]}

    async def llm(msgs):
        seen.append(json.dumps(msgs))
        return GOOD

    async def write(req):
        return {"accepted": True}

    run(g.run_group_words("u", llm_fn=llm, read_fn=read, state_fn=state, write_fn=write))
    assert "ER nurse" in seen[0] and "chef" not in seen[0] and "npc:" not in seen[0]

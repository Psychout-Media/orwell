"""ORW-434 - the faithfulness judge's projection carries time + sleep facts, is truncated structurally
(always valid JSON), and the judge has a "time" dimension that routes to the existing reground lever.
Roles only; no names."""
import asyncio
import json
import re

import pytest

from src.agent_loop import _faith_build_projection, _faith_check
from src.faithfulness import FAITH_DIMENSIONS, FaithfulnessJudge, serialize_projection

_CLOCK = re.compile(r"\d:\d\d")


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _night_state():
    return {
        "week": 2, "phase": "veto", "timeOfDay": "night", "clockLabel": "11:30pm, Day 3",
        "daySchedule": {"next": "veto-competition", "tomorrow": True, "phase": "afternoon", "due": False},
        "whereabouts": {"room": "kitchen", "present": [{"id": "npc:1", "name": "Present Role A"}]},
        "asleep": [{"id": "npc:2", "name": "Sleeper Role A"}, {"id": "npc:3", "name": "Sleeper Role B"}],
        "secretXYZ": "NOPE",
    }


def _patch_reads(monkeypatch, gs=None, vs=None):
    async def _state(*a, **k):
        return gs if gs is not None else _night_state()

    async def _visible(*a, **k):
        return vs if vs is not None else {"knowledge": [{"id": "k1"}]}
    monkeypatch.setattr("src.orwell_engine.get_game_state", _state)
    monkeypatch.setattr("src.orwell_engine.get_visible_state", _visible)


def _zero_clocks(monkeypatch, on):
    monkeypatch.setattr("src.zero_clocks.zero_clocks_on", lambda: on)


def test_night_projection_carries_band_next_event_day_and_asleep(monkeypatch):
    _patch_reads(monkeypatch)
    _zero_clocks(monkeypatch, True)
    proj = _run(_faith_build_projection("u1"))
    t = proj["time"]
    assert t["partOfDay"] == "night"
    assert t["nextEvent"] == {"name": "veto-competition", "when": "tomorrow", "partOfDay": "afternoon", "due": False}
    assert t["playerRoom"] == "kitchen"
    assert t["asleep"] == ["Sleeper Role A", "Sleeper Role B"]
    assert "secretXYZ" not in json.dumps(proj)


def test_zero_clocks_on_has_no_clock_number_anywhere(monkeypatch):
    _patch_reads(monkeypatch)
    _zero_clocks(monkeypatch, True)
    proj = _run(_faith_build_projection("u1"))
    assert not _CLOCK.search(json.dumps(proj))


def test_time_block_is_fail_soft_without_schedule(monkeypatch):
    _patch_reads(monkeypatch, gs={"week": 1, "phase": "hoh"})
    proj = _run(_faith_build_projection("u1"))
    assert proj["board"]["phase"] == "hoh"
    assert "nextEvent" not in proj.get("time", {})   # no schedule => never invent one


def test_long_knowledge_list_is_cut_to_valid_json_keeping_newest():
    know = [{"id": f"k{i:04d}", "text": "x" * 40} for i in range(500)]   # ~25k chars
    proj = {"board": {"week": 1}, "visible": {"knowledge": know}}
    assert len(json.dumps(proj)) > 20000
    out = serialize_projection(proj, 6000)
    assert len(out) <= 6000
    parsed = json.loads(out)
    kept = parsed["visible"]["knowledge"]
    assert kept and kept[-1]["id"] == "k0499"                      # newest survives
    assert kept[0]["id"] != "k0000"                                # oldest dropped
    assert [k["id"] for k in kept] == sorted(k["id"] for k in kept)  # whole entries, order intact
    assert parsed["board"] == {"week": 1}


def test_small_projection_is_unchanged():
    proj = {"board": {"week": 1}, "visible": {"knowledge": [{"id": "a"}]}}
    assert json.loads(serialize_projection(proj, 6000)) == proj


def test_unshrinkable_projection_still_parses():
    proj = {"board": {"blob": "y" * 20000}, "visible": {"knowledge": [{"id": "a"}]}}
    out = serialize_projection(proj, 6000)
    json.loads(out)
    assert len(out) <= 6000


def test_prompt_uses_structured_truncation_and_time_dimension():
    j = FaithfulnessJudge(lambda p: "")
    know = [{"id": f"k{i}", "text": "z" * 50} for i in range(600)]
    p = j.build_prompt("narr", {"visible": {"knowledge": know}})
    body = p.split("PROJECTION:\n", 1)[1]
    json.loads(body)
    assert "time" in FAITH_DIMENSIONS
    assert "part of day" in p and "asleep" in p
    assert "BEYOND the projection as a potential leak" in p


def test_time_verdict_is_parsed_and_forced_to_reground():
    j = FaithfulnessJudge(lambda p: "")
    v = j.verdict_from_reply(json.dumps({"dimension": "time", "classification": "closed",
                                         "lever": "reground", "rationale": "says morning at night"}))
    assert v.dimension == "time" and v.lever == "reground" and v.is_slip
    # an out-of-lane lever for a time slip is routed to reground, and adopt is never honoured
    v2 = j.verdict_from_reply(json.dumps({"dimension": "time", "classification": "open",
                                          "lever": "adopt", "rationale": "x"}))
    assert v2.dimension == "time" and v2.lever == "reground" and v2.classification == "closed"


def _setup_check(monkeypatch, tmp_path, mode, reply):
    from src import settings as _s
    from src.settings import save_settings
    monkeypatch.setattr(_s, "SETTINGS_FILE", str(tmp_path / "settings.json"))
    monkeypatch.setattr(_s, "_settings_cache", None)
    monkeypatch.delenv("ORWELL_FAITHFULNESS_MODE", raising=False)
    monkeypatch.delenv("ORWELL_FAITHFULNESS_UNREFRAMABLE", raising=False)
    save_settings({"faithfulness_mode": mode})
    _patch_reads(monkeypatch)

    async def _resolve(owner=None, **kw):
        return lambda prompt: reply
    monkeypatch.setattr("src.orwell_cast_authoring._resolve_llm_fn", _resolve)
    logged = []
    monkeypatch.setattr("src.log_rings.record_overseer", lambda *a, **k: logged.append((a, k)))
    from routes import chat_helpers
    store = {}
    monkeypatch.setattr(chat_helpers, "_DESYNC_REGROUND", store)
    return logged, store


_TIME_REPLY = json.dumps({"dimension": "time", "classification": "closed", "lever": "reground",
                          "rationale": "a sleeper speaks"})


def _check():
    return _faith_check("the sun is up", claim_bearing=True, engaged_scene=False, owner="u1",
                        endpoint_url="http://x", model="m", headers={}, last_user="hi")


def test_active_time_verdict_queues_the_reground(monkeypatch, tmp_path):
    logged, store = _setup_check(monkeypatch, tmp_path, "active", _TIME_REPLY)
    _run(_check())
    assert "u1" in store and store["u1"]
    assert any(a[1] == "faith:time" for a, _k in logged)


def test_shadow_time_verdict_only_logs(monkeypatch, tmp_path):
    logged, store = _setup_check(monkeypatch, tmp_path, "shadow", _TIME_REPLY)
    _run(_check())
    assert store == {}
    assert any(a[1] == "faith:time" for a, _k in logged)


# ---- review fixes: a turn that crosses a time change; the both-set slip rule; no time dimension in casting ----

def test_prompt_says_the_time_block_is_end_of_turn_and_narration_may_cover_earlier_moments():
    p = FaithfulnessJudge(lambda p: "").build_prompt("narr", {"time": {"partOfDay": "late night"}})
    assert "END of the turn" in p and "EARLIER moments" in p and "ANY point of the turn" in p
    assert "partOfDayAtStart" in p


def test_time_advancing_tool_events_are_recognised():
    from src.agent_loop import _faith_turn_advanced_time
    assert _faith_turn_advanced_time([{"tool": "recordInteraction"}, {"tool": "turnIn"}])
    assert _faith_turn_advanced_time([{"tool": "nap"}])
    assert not _faith_turn_advanced_time([{"tool": "recordInteraction"}, {"tool": "moveTo"}])
    assert not _faith_turn_advanced_time(None)


def test_a_turn_that_advanced_time_skips_the_time_dimension(monkeypatch, tmp_path):
    logged, store = _setup_check(monkeypatch, tmp_path, "active", _TIME_REPLY)
    prompts = []

    async def _resolve(owner=None, **kw):
        return lambda prompt: (prompts.append(prompt), _TIME_REPLY)[1]
    monkeypatch.setattr("src.orwell_cast_authoring._resolve_llm_fn", _resolve)
    _run(_faith_check("the sun is up", claim_bearing=True, engaged_scene=False, owner="u1", endpoint_url="http://x",
                      model="m", headers={}, last_user="hi", time_advanced=True))
    assert prompts and '"time"' not in prompts[0].split("PROJECTION:\n", 1)[1]   # the end-of-turn block is withheld
    assert store == {}                                                              # a time verdict cannot reground it
    assert not any(a[1] == "faith:time" for a, _k in logged)


@pytest.mark.parametrize("reply", [
    {"dimension": "time", "classification": "none", "lever": "reground", "rationale": "x"},
    {"dimension": "time", "classification": "closed", "lever": "none", "rationale": "x"},
])
def test_a_self_contradictory_time_reply_is_not_a_slip(reply):
    v = FaithfulnessJudge(lambda p: "").verdict_from_reply(json.dumps(reply))
    assert v is not None and not v.is_slip


def test_casting_context_has_no_time_dimension():
    j = FaithfulnessJudge(lambda p: "")
    p = j.build_prompt("narr", {}, "casting")
    assert "'time'" not in p.split("Decide three things:")[1].split("classification:")[0]
    reply = json.dumps({"dimension": "time", "classification": "closed", "lever": "reground", "rationale": "x"})
    v = j.verdict_from_reply(reply, "narr", {}, "casting")
    assert v is None or not (v.dimension == "time" or v.is_slip)
    assert j.verdict_from_reply(reply, "narr", {}).lever == "reground"   # in-game unchanged


def test_a_deferred_check_that_rebuilds_its_projection_carries_no_time_block(monkeypatch, tmp_path):
    """ORW-434: a turn judged LATER (the retro queue) with no stored projection gets a projection built at the later moment.
    Its board fields are still a fair reference, but its `time` block describes a different moment than the narration,
    so it is withheld (a stored projection, taken at the turn's own moment, keeps its time block)."""
    import tests.test_1659_r5_guard_down as r5
    from src import agent_loop
    r5._set_mode(monkeypatch, tmp_path, "shadow")
    r5._patch_engine_reads(monkeypatch)
    q = r5._isolate_queue(monkeypatch)
    r5._capture_llmio(monkeypatch)
    r5._capture_overseer(monkeypatch)

    async def later_projection(owner):
        return {"board": {"week": 1}, "time": {"partOfDay": "morning", "asleep": ["Sleeper"]}}

    monkeypatch.setattr(agent_loop, "_faith_build_projection", later_projection)
    prompts = []
    clean = json.dumps({"dimension": "none", "classification": "none", "lever": "none", "rationale": ""})

    def llm(prompt):
        prompts.append(str(prompt))
        return clean

    q["u1"] = [{"narration": "an old night scene", "projection": None, "beat_before": 3, "context": "in-game"},
               {"narration": "a turn with its own projection", "projection": {"board": {"week": 1}, "time": {"partOfDay": "night"}},
                "beat_before": 4, "context": "in-game"}]
    r5._run(agent_loop._faith_drain_retro("u1", llm))
    assert len(prompts) == 2
    assert '"partOfDay"' not in prompts[0] and "Sleeper" not in prompts[0]      # rebuilt later: no time block
    assert '"partOfDay": "night"' in prompts[1]                                   # stored at its own moment: kept


def test_a_deferred_time_verdict_with_no_time_facts_is_not_a_slip(monkeypatch, tmp_path):
    """ORW-434: the deferred check follows the live check's rule. When the judge was given no time block for a turn, a
    time verdict has nothing to stand on: it is recorded as discarded, not as a slip. With a stored time block the same
    reply IS a slip."""
    import tests.test_1659_r5_guard_down as r5
    from src import agent_loop
    r5._set_mode(monkeypatch, tmp_path, "shadow")
    r5._patch_engine_reads(monkeypatch)
    q = r5._isolate_queue(monkeypatch)
    r5._capture_llmio(monkeypatch)
    logged = r5._capture_overseer(monkeypatch)
    q["u1"] = [{"narration": "a turn that crossed into morning", "projection": {"board": {"week": 1}},
                "beat_before": 3, "context": "in-game"},
               {"narration": "a turn with its own time block", "projection": {"board": {"week": 1}, "time": {"partOfDay": "night"}},
                "beat_before": 4, "context": "in-game"}]
    r5._run(agent_loop._faith_drain_retro("u1", lambda prompt: _TIME_REPLY))
    tags = [(a[1], k.get("beat_before"), k.get("ok")) for a, k in logged]
    assert ("faith:retro-time-unfounded", 3, True) in tags
    assert ("faith:retro:time", 4, False) in tags
    assert ("faith:retro:time", 3, False) not in tags
    assert not q.get("u1")                                   # both judged of record; nothing requeued


def test_a_guard_down_turn_that_advanced_time_defers_without_the_time_block(monkeypatch, tmp_path):
    """ORW-434: when the judge model cannot be resolved the turn is deferred with the projection pinned at the turn. On a
    turn that advanced the clock that board is END-of-turn, so the pinned projection carries no time block (a turn that
    did not advance the clock keeps it)."""
    import tests.test_1659_r5_guard_down as r5
    from src import agent_loop
    r5._set_mode(monkeypatch, tmp_path, "shadow")
    r5._patch_engine_reads(monkeypatch)
    q = r5._isolate_queue(monkeypatch)
    r5._capture_llmio(monkeypatch)
    r5._capture_overseer(monkeypatch)

    async def end_of_turn_projection(owner):
        return {"board": {"week": 1}, "time": {"partOfDay": "morning", "asleep": []}}

    monkeypatch.setattr(agent_loop, "_faith_build_projection", end_of_turn_projection)

    async def _no_model(owner=None, **kw):
        raise RuntimeError("no judge model")
    monkeypatch.setattr("src.orwell_cast_authoring._resolve_llm_fn", _no_model)

    def check(**kw):
        return _faith_check("lights out, then the sun comes up", claim_bearing=True, engaged_scene=False, owner="u1",
                            endpoint_url="http://x", model="m", headers={}, last_user="hi", **kw)

    r5._run(check(time_advanced=True))
    r5._run(check())
    entries = q.get("u1") or []
    assert len(entries) == 2
    assert "time" not in entries[0]["projection"] and entries[0]["projection"]["board"] == {"week": 1}
    assert entries[1]["projection"]["time"]["partOfDay"] == "morning"


def test_a_board_without_a_sleep_fact_publishes_no_asleep_field(monkeypatch):
    """review of #2741: `asleep: []` for a board that says nothing about sleep read as proof that everyone is awake."""
    _zero_clocks(monkeypatch, True)
    _patch_reads(monkeypatch, gs={"week": 1, "phase": "hoh", "timeOfDay": "night", "whereabouts": {"room": "kitchen"}})
    assert "asleep" not in _run(_faith_build_projection("u1"))["time"]
    _patch_reads(monkeypatch, gs={"week": 1, "phase": "hoh", "timeOfDay": "night", "whereabouts": {"room": "kitchen"}, "asleep": []})
    assert _run(_faith_build_projection("u1"))["time"]["asleep"] == []


def test_a_held_or_failed_time_write_does_not_switch_the_time_dimension_off():
    """review of #2741: any event named turnIn / nap / ... counted as a clock write, even a refused one."""
    from src.agent_loop import _faith_turn_advanced_time
    assert not _faith_turn_advanced_time([{"tool": "turnIn", "output": '{"held": true, "reason": "bedtime"}', "exit_code": 0}])
    assert not _faith_turn_advanced_time([{"tool": "nap", "output": "engine refused", "exit_code": 1}])
    assert not _faith_turn_advanced_time([{"tool": "advanceGame", "output": '{"error": "no such beat"}', "exit_code": 0}])
    assert _faith_turn_advanced_time([{"tool": "turnIn", "output": '{"status": {"timeOfDay": "morning"}}', "exit_code": 0}])
    assert _faith_turn_advanced_time([{"tool": "nap", "output": "", "exit_code": 0}])
